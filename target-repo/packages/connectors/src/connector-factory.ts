import { EqaConsumer } from './eqa-consumer';
import { EqaProducer } from './eqa-producer';
import { CredentialNormalizer } from './credential-normalizer';
import type {
    Connector,
    ConsumerConfig,
    ProducerConfig,
    EventHubConsumerConfig,
    EventHubProducerConfig,
    PulsarConsumerConfig,
    PulsarProducerConfig,
    PulsarCredential,
    EventHubCanonicalCredential
} from '@packages/drs-types';
import { createHash } from 'crypto';
import {
    StreamType,
    FlushType,
    InputStreamParams,
    OutputStreamParams
} from '@motorq/event-queue-abstraction';
import { getBlobForCheckpointing } from './blob-maker';
import * as jwt from 'jsonwebtoken';
import * as logger from '@motorq/logger';

/**
 * Factory for creating EQA-based consumers and producers
 * All connector type intelligence lives here
 */
export class ConnectorFactory {
    /**
     * Create consumer with auto-configured EQA params
     */
    static async createConsumer(
        connector: Connector,
        overrides?: Partial<ConsumerConfig>
    ): Promise<EqaConsumer> {
        // Normalize connector credentials (all EventHub formats → connection string)
        const {
            credential: normalizedCredential,
            config: normalizedConfig
        } = CredentialNormalizer.normalizeConnector(connector);

        // Merge configs: normalized < overrides
        const mergedConfig = {
            ...normalizedConfig,
            ...overrides
        };

        logger.trackTrace({
            message: `Creating EQA consumer`,
            args: { connectorId: connector.id, type: connector.type }
        });

        // Build EQA params based on connector type
        let params: InputStreamParams;

        if (connector.type === 'EVENTHUB') {
            params = await this.buildEventHubConsumerParams(
                normalizedCredential,
                mergedConfig as EventHubConsumerConfig & {
                    storageConnectionString?: string;
                    checkpointContainerName?: string;
                }
            );
        } else {
            params = this.buildPulsarConsumerParams(
                normalizedCredential,
                mergedConfig as PulsarConsumerConfig
            );
        }

        return new EqaConsumer(params);
    }

    /**
     * Create producer with auto-configured EQA params and auto-detected partition count
     */
    static async createProducer(
        connector: Connector,
        overrides?: Partial<ProducerConfig>
    ): Promise<EqaProducer> {
        // Normalize connector credentials (all EventHub formats → connection string)
        const {
            credential: normalizedCredential,
            config: normalizedConfig
        } = CredentialNormalizer.normalizeConnector(connector);

        const mergedConfig = {
            ...normalizedConfig,
            ...overrides
        };

        logger.trackTrace({
            message: `Creating EQA producer`,
            args: {
                connectorId: connector.id,
                type: connector.type
            }
        });

        // Build EQA params based on connector type
        let params: OutputStreamParams;

        if (connector.type === 'EVENTHUB') {
            params = this.buildEventHubProducerParams(
                normalizedCredential,
                mergedConfig as EventHubProducerConfig
            );
        } else {
            params = this.buildPulsarProducerParams(
                normalizedCredential,
                mergedConfig as PulsarProducerConfig
            );
        }

        return new EqaProducer(params);
    }

    /**
     * Build EQA InputStreamParams for EventHub consumer
     * Credential contains: {eventHubConnectionString, eventHub, consumerGroup}
     * (normalized from canonical format by CredentialNormalizer)
     */
    private static async buildEventHubConsumerParams(
        credential: any,
        config: EventHubConsumerConfig & {
            storageConnectionString?: string;
            checkpointContainerName?: string;
            eventHub?: string;
            consumerGroup?: string;
        }
    ): Promise<InputStreamParams> {
        // After normalization, credential has eventHubConnectionString
        // and config has eventHub/consumerGroup extracted from canonical credential
        const eventHubConnectionString = credential.eventHubConnectionString;
        const eventHub = config.eventHub;
        const consumerGroup = config.consumerGroup;

        // Validate required fields
        if (!eventHubConnectionString) {
            throw new Error('EventHub connection string is required');
        }
        if (!eventHub) {
            throw new Error('EventHub name (eventHub) is required');
        }
        if (!consumerGroup) {
            throw new Error('consumerGroup is required');
        }
        if (!config.storageConnectionString) {
            throw new Error('storageConnectionString required for EventHub consumer');
        }
        if (!config.checkpointContainerName) {
            throw new Error('checkpointContainerName required for EventHub consumer');
        }

        // Ensure blob container exists
        await getBlobForCheckpointing(
            config.storageConnectionString,
            config.checkpointContainerName
        );

        return {
            sourceType: StreamType.EVENT_HUB,
            partitions: undefined,
            fetchRate: config.fetchRate ?? 1000,
            maxWaitTime: config.maxWaitTime ?? 2,
            maxBufferMessages: config.maxBufferMessages ?? 50000,
            minBufferMessages: config.minBufferMessages ?? 3000,
            sourceSpecificConfig: {
                eventHubConnectionString,
                eventHub,
                consumerGroup,
                checkpointStore: {
                    mode: 'blob',
                    config: {
                        storageConnectionString: config.storageConnectionString,
                        containerName: config.checkpointContainerName,
                        subscriptionInitialPosition: config.subscriptionInitialPosition ?? 'Earliest'
                    }
                }
            }
        } as unknown as InputStreamParams;
    }

    /**
     * Extract StreamNative service account from a Pulsar JWT token.
     * Returns null if token is empty, invalid, or doesn't contain the StreamNative field.
     */
    static extractServiceAccountFromToken(token: string | null | undefined): string | null {
        if (!token || token.trim() === '') return null;

        try {
            const decoded = jwt.decode(token);
            if (!decoded || typeof decoded !== 'object') return null;

            const serviceAccount = decoded['https://streamnative.io/username'];
            return (serviceAccount && typeof serviceAccount === 'string') ? serviceAccount : null;
        } catch {
            logger.trackTrace({ message: 'Failed to decode Pulsar JWT token, skipping subscription prefix' });
            return null;
        }
    }

    /**
     * Build EQA InputStreamParams for Pulsar consumer
     */
    private static buildPulsarConsumerParams(
        credential: any,
        config: PulsarConsumerConfig
    ): InputStreamParams {
        const pulsarCredential = credential as PulsarCredential;

        // Validate required fields
        if (!config.topic) {
            throw new Error('Topic name is required in config');
        }
        if (!config.subscriptionName) {
            throw new Error('subscriptionName is required in config');
        }

        // Auto-prefix subscription name with service account if available
        let subscriptionName = config.subscriptionName;
        const serviceAccount = this.extractServiceAccountFromToken(pulsarCredential.pulsarAccessToken);

        if (serviceAccount) {
            subscriptionName = `${serviceAccount}-${subscriptionName}`;
            logger.trackTrace({
                message: 'Prefixed Pulsar subscription name with service account',
                args: { original: config.subscriptionName, prefixed: subscriptionName }
            });
        }
        subscriptionName = subscriptionName.replace(/\//g, '_');

        return {
            sourceType: StreamType.PULSAR,
            partitions: undefined,
            fetchRate: config.fetchRate ?? 1000,
            maxWaitTime: config.maxWaitTime ?? 2,
            maxBufferMessages: config.maxBufferMessages ?? 50000,
            minBufferMessages: config.minBufferMessages ?? 3000,
            sourceSpecificConfig: {
                ...pulsarCredential,
                ...config,
                subscriptionName,
                subscriptionType: 'Failover' as const,
                batchReceivePolicy: {
                    maxNumMessages: config.fetchRate ?? 100,
                    maxNumBytes: 10 * 1024 * 1024,
                    timeoutMs: (config.maxWaitTime ?? 5) * 1000
                }
            }
        } as unknown as InputStreamParams;
    }

    /**
     * Build EQA OutputStreamParams for EventHub producer
     * Credential contains: {eventHubConnectionString}
     * Config contains: {eventHub, partitionCount, ...}
     * (normalized from canonical format by CredentialNormalizer)
     */
    private static buildEventHubProducerParams(
        credential: any,
        config: EventHubProducerConfig & { eventHub?: string }
    ): OutputStreamParams {
        // After normalization, credential has eventHubConnectionString
        // and config has eventHub extracted from canonical credential
        const eventHubConnectionString = credential.eventHubConnectionString;
        const eventHub = config.eventHub;

        // Validate required fields
        if (!eventHubConnectionString) {
            throw new Error('EventHub connection string is required');
        }
        if (!eventHub) {
            throw new Error('EventHub name (eventHub) is required');
        }

        return {
            targetType: StreamType.EVENT_HUB,
            flushType: FlushType.BATCH,
            _disableInternalFlushBuffer: true,
            autoDetectPartitionCount: true,
            partitionIdFn: (event: any) => {
                return event.body?.partitionKey || event.body?.vId || event.body?.vehicleId || 'default';
            },
            bufferFlushTime: config.bufferFlushTime ?? 5000,
            batchPreCommitFn: async (batchIds: string[]) => {
                logger.trackTrace({
                    message: `Preparing to send ${batchIds.length} batches to EventHub`
                });
            },
            batchPostCommitFn: async (batchIds: string[]) => {
                logger.trackTrace({
                    message: `Successfully sent ${batchIds.length} batches to EventHub`
                });
            },
            batchCheckpointFn: async (batchIds: string[]) => {
                logger.trackTrace({
                    message: `Checkpointing ${batchIds.length} batches for EventHub`
                });
            },
            targetSpecificConfig: {
                eventHubConnectionString,
                eventHub
            }
        } as OutputStreamParams;
    }

    /**
     * Build EQA OutputStreamParams for Pulsar producer
     */
    private static buildPulsarProducerParams(
        credential: any,
        config: PulsarProducerConfig
    ): OutputStreamParams {
        const pulsarCredential = credential as PulsarCredential;

        // Validate required fields
        if (!config.topic) {
            throw new Error('Topic name is required in config');
        }

        return {
            targetType: StreamType.PULSAR,
            flushType: FlushType.BATCH,
            _disableInternalFlushBuffer: true,
            autoDetectPartitionCount: true,
            partitionIdFn: (event: any) => {
                return event.body?.partitionKey || event.body?.vId || event.body?.vehicleId || 'default';
            },
            bufferFlushTime: config.bufferFlushTime ?? 5000,
            batchPreCommitFn: async (batchIds: string[]) => {
                logger.trackTrace({
                    message: `Preparing to send ${batchIds.length} batches to Pulsar`
                });
            },
            batchPostCommitFn: async (batchIds: string[]) => {
                logger.trackTrace({
                    message: `Successfully sent ${batchIds.length} batches to Pulsar`
                });
            },
            batchCheckpointFn: async (batchIds: string[]) => {
                logger.trackTrace({
                    message: `Checkpointing ${batchIds.length} batches for Pulsar`
                });
            },
            targetSpecificConfig: {
                ...pulsarCredential,
                ...config,
                producerConfig: {
                    producerName: config.producerName,
                    batchingMaxMessages: config.batchingMaxMessages ?? 100,
                    batchingMaxPublishDelay: config.batchingMaxPublishDelay ?? 1000,
                    sendTimeout: config.sendTimeout ?? 30000,
                    compressionType: config.compressionType || 'LZ4',
                    batchingType: 'DefaultBatching' as const
                }
            }
        } as unknown as OutputStreamParams;
    }

    /**
     * Derives an output stream identity key from a connector's config.
     * Outlets with the same outputStreamKey share a single producer.
     *
     * - Pulsar: PULSAR|<serviceUrl>|<topic>|<hash(accessToken)>
     * - EventHub: EVENTHUB|<entityPath>|<hash(connectionString)>
     *
     * Secrets (accessToken, connectionString) are hashed — never stored raw in cache keys.
     */
    static deriveOutputStreamKey(connector: Connector): string {
        if (connector.type === 'PULSAR') {
            const cred = connector.credential as PulsarCredential;
            const cfg = connector.config as PulsarProducerConfig;

            if (!cred.pulsarServiceUrl || !cfg?.topic) {
                throw new Error(`Invalid Pulsar connector config for connector ${connector.id}`);
            }

            const tokenHash = createHash('sha256').update(cred.pulsarAccessToken).digest('hex').substring(0, 16);
            return `PULSAR|${cred.pulsarServiceUrl}|${cfg.topic}|${tokenHash}`;
        } else if (connector.type === 'EVENTHUB') {
            const cred = connector.credential as EventHubCanonicalCredential;

            if (!cred.connectionString || !cred.entityPath) {
                throw new Error(`Invalid EventHub connector config for connector ${connector.id}`);
            }

            const connStringHash = createHash('sha256').update(cred.connectionString).digest('hex').substring(0, 16);
            return `EVENTHUB|${cred.entityPath}|${connStringHash}`;
        } else {
            throw new Error(`Unsupported connector type: ${connector.type} for connector ${connector.id}`);
        }
    }

    /**
     * Validate EventHub connection by attempting to create and initialize a producer.
     * This is a lightweight validation that creates a producer, initializes it, and closes it.
     * Throws on failure.
     */
    static async validateEventHubConnection(
        credential: { eventHubConnectionString: string },
        config: { eventHub: string }
    ): Promise<void> {
        const eventHubConnectionString = credential.eventHubConnectionString;
        const eventHub = config.eventHub;

        if (!eventHubConnectionString) {
            throw new Error('EventHub connection string is required');
        }

        if (!eventHub) {
            throw new Error('EventHub name is required');
        }

        // Build minimal producer params for validation
        const params: OutputStreamParams = {
            targetType: StreamType.EVENT_HUB,
            flushType: FlushType.BATCH,
            _disableInternalFlushBuffer: true,
            autoDetectPartitionCount: true,
            partitionIdFn: () => 'default',
            bufferFlushTime: 5000,
            targetSpecificConfig: {
                eventHubConnectionString,
                eventHub
            }
        } as OutputStreamParams;

        let producer: EqaProducer | null = null;

        try {
            producer = new EqaProducer(params);
            // connect() calls init() which validates the connection
            await producer.connect();

            // Validate connection by getting partition count
            const partitionCount = await producer.getPartitionCount();

            if (typeof partitionCount !== 'number' || partitionCount <= 0) {
                throw new Error(`Invalid partition count: ${partitionCount}`);
            }

            logger.trackTrace({
                message: 'EventHub connection validated successfully',
                args: { eventHub, partitionCount }
            });
        } catch (error) {
            throw new Error(`Failed to connect to EventHub ${eventHub}: ${(error as Error).message}`);
        } finally {
            if (producer) {
                try {
                    await producer.close();
                } catch {
                    // Ignore close errors during validation
                }
            }
        }
    }

    /**
     * Validate Pulsar connection by attempting to create and initialize a producer.
     * This is a lightweight validation that creates a producer, initializes it, and closes it.
     * Throws on failure.
     */
    static async validatePulsarConnection(
        credential: { pulsarServiceUrl: string; pulsarAccessToken: string },
        config: { topic: string }
    ): Promise<void> {
        const pulsarServiceUrl = credential.pulsarServiceUrl;
        const pulsarAccessToken = credential.pulsarAccessToken;
        const topic = config.topic;

        if (!pulsarServiceUrl) {
            throw new Error('Pulsar service URL is required');
        }

        if (!topic) {
            throw new Error('Pulsar topic is required');
        }

        // Build minimal producer params for validation
        const params: OutputStreamParams = {
            targetType: StreamType.PULSAR,
            flushType: FlushType.BATCH,
            _disableInternalFlushBuffer: true,
            autoDetectPartitionCount: true,
            partitionIdFn: () => 'default',
            bufferFlushTime: 5000,
            targetSpecificConfig: {
                pulsarServiceUrl,
                pulsarAccessToken,
                topic,
                producerConfig: {
                    producerName: `validation-producer-${Date.now()}`,
                    batchingMaxMessages: 10,
                    batchingMaxPublishDelay: 1000,
                    sendTimeout: 5000,
                    compressionType: 'LZ4',
                    batchingType: 'DefaultBatching' as const
                }
            }
        } as unknown as OutputStreamParams;

        let producer: EqaProducer | null = null;

        try {
            producer = new EqaProducer(params);
            // connect() calls init() which validates the connection
            await producer.connect();

            // Validate connection by getting partition count
            const partitionCount = await producer.getPartitionCount();

            if (typeof partitionCount !== 'number' || partitionCount <= 0) {
                throw new Error(`Invalid partition count: ${partitionCount}`);
            }

            logger.trackTrace({
                message: 'Pulsar connection validated successfully',
                args: { topic, partitionCount }
            });
        } catch (error) {
            throw new Error(`Failed to connect to Pulsar topic ${topic}: ${(error as Error).message}`);
        } finally {
            if (producer) {
                try {
                    await producer.close();
                } catch {
                    // Ignore close errors during validation
                }
            }
        }
    }

}
