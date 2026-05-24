import type {
    ConsumerConfig,
    ProducerConfig,
    PulsarCredential,
    EventHubConsumerConfig,
    EventHubProducerConfig,
    EventHubCanonicalCredential,
    Connector
} from '@packages/drs-types';
import * as logger from '@motorq/logger';

/**
 * Normalized EventHub credential format for EQA
 * Contains just the connection string - eventHub and consumerGroup go to config
 */
export interface NormalizedEventHubCredential {
    eventHubConnectionString: string;
}

/**
 * Normalized config with eventHub and consumerGroup extracted from credential
 */
export interface NormalizedEventHubConfig {
    eventHub: string;
    consumerGroup: string;
}

/**
 * CredentialNormalizer transforms control plane canonical format to EQA format
 *
 * Control Plane Canonical Format:
 * - EventHub: {connectionString, entityPath, consumerGroup}
 * - Pulsar: {pulsarServiceUrl, pulsarAccessToken}
 *
 * EQA Format (output):
 * - EventHub credential: {eventHubConnectionString}
 * - EventHub config: {eventHub, consumerGroup, ...}
 * - Pulsar: pass through unchanged
 */
export class CredentialNormalizer {

    /**
     * Normalize connector credentials from control plane format to EQA format
     * Uses connector.type as the source of truth
     */
    static normalizeConnector(
        connector: Connector
    ): {
        credential: NormalizedEventHubCredential | PulsarCredential;
        config: Partial<ConsumerConfig | ProducerConfig> & Partial<NormalizedEventHubConfig>;
    } {
        logger.trackTrace({
            message: `Normalizing connector credentials`,
            args: {
                connectorId: connector.id,
                type: connector.type
            }
        });

        if (connector.type === 'EVENTHUB') {
            return this.normalizeEventHubCredential(
                connector.credential as EventHubCanonicalCredential,
                connector.config
            );
        } else if (connector.type === 'PULSAR') {
            // Pulsar credentials pass through unchanged
            return {
                credential: connector.credential as PulsarCredential,
                config: connector.config || {}
            };
        } else {
            throw new Error(`Unknown connector type: ${connector.type}`);
        }
    }

    /**
     * Normalize EventHub canonical credential to EQA format
     *
     * Input (canonical): {connectionString, entityPath, consumerGroup}
     * Output credential: {eventHubConnectionString}
     * Output config: {eventHub, consumerGroup, ...existingConfig}
     */
    private static normalizeEventHubCredential(
        credential: EventHubCanonicalCredential,
        config: any
    ): {
        credential: NormalizedEventHubCredential;
        config: Partial<EventHubConsumerConfig | EventHubProducerConfig> & NormalizedEventHubConfig;
    } {
        logger.trackTrace({
            message: 'Normalizing EventHub canonical credential to EQA format',
            args: { entityPath: credential.entityPath }
        });

        // Validate canonical format
        if (!credential.connectionString) {
            throw new Error('connectionString is required in EventHub credential');
        }
        if (!credential.entityPath) {
            throw new Error('entityPath is required in EventHub credential');
        }
        if (!credential.consumerGroup) {
            throw new Error('consumerGroup is required in EventHub credential');
        }

        return {
            credential: {
                eventHubConnectionString: credential.connectionString
            },
            config: {
                eventHub: credential.entityPath,
                consumerGroup: credential.consumerGroup,
                ...config  // Merge any additional config (performance params, etc.)
            }
        };
    }
}
