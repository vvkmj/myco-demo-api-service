import { ControlPlaneClient } from '../clients/controlPlane.client';
import { DLQDataAccess, DLQEntry } from '../data-access/dlq.data-access';
import { MetricsHelper } from '../common/metrics';
import { EqaProducer } from '@packages/connectors';
import { getMetricCollector } from '@motorq/metric-collector';
import * as logger from '@motorq/logger';
import { OutletProducerManager } from '../services/outletProducerManager.service';

const metricCollector = getMetricCollector();
export interface DLQProcessor {
    processStickyMessages(): Promise<void>;
    processStaticMessages(): Promise<void>;
    close(): Promise<void>;
}

export class DLQProcessorImpl implements DLQProcessor {
    private readonly batchSize: number = 100;
    private dlqDataAccess: DLQDataAccess;
    private outletProducerManager: OutletProducerManager;

    constructor(private readonly controlPlaneClient: ControlPlaneClient) {
        this.dlqDataAccess = DLQDataAccess.getInstance();
        this.outletProducerManager = OutletProducerManager.getInstance(controlPlaneClient);
    }

    async processStickyMessages(): Promise<void> {
        try {
            // Get all outlets with pending sticky messages
            const outletIds = await this.dlqDataAccess.getStickyOutletIds();
            metricCollector.recordGaugeValue(
                'dlq_outlets_pending',
                outletIds.length,
                { attributes: { routing_type: 'sticky' } }
            );
            if (outletIds.length === 0) {
                logger.trackTrace({ message: 'No sticky messages pending processing' });
                return;
            }
            logger.trackTrace({ message: `Found ${outletIds.length} outlets with sticky messages` });
            
            // Process each outlet
            for (const outletId of outletIds) {
                await this.processOutlet(outletId);
            }
        } catch (error) {
            metricCollector.recordMessageCount(
                'dlq_processing_errors',
                1,
                { attributes: { routing_type: "sticky" } }
            );
            logger.trackException({ exception: (error as Error), message: `Error while processing sticky messages` });
            throw error;
        }
    }

    async processStaticMessages(): Promise<void> {
        try {
            // Get all pending static keys
            const pendingStatic = await this.dlqDataAccess.getPendingStaticKeys();
            metricCollector.recordGaugeValue(
                'dlq_outlets_pending',
                pendingStatic.length,
                { attributes: { routing_type: 'static' } }
            );
            if (pendingStatic.length === 0) {
                logger.trackTrace({ message: 'No static messages pending for processing' });
                return;
            }
            logger.trackTrace({ message: `Found ${pendingStatic.length} static keys pending mapping` });
            // Group by app name for efficient processing
            const staticByApp = pendingStatic.reduce((acc, { app_name, static_key }) => {
                if (!acc[app_name]) {
                    acc[app_name] = [];
                }
                acc[app_name].push(static_key);
                return acc;
            }, {} as Record<string, string[]>);

            // Process each app's static keys
            for (const [appName, keys] of Object.entries(staticByApp)) {
                const attributes = { app_name: appName };
                try {
                    const mappings = await MetricsHelper.recordTiming(
                        'dlq_static_mapping_fetch',
                        () => this.controlPlaneClient.getStaticMappings(appName, keys),
                        attributes
                    );
                    logger.trackTrace({ message: `Found ${mappings?.length} mappings for app ${appName} and keys ${keys.join(', ')}` });
                    // Update outlet IDs for mapped keys
                    for (const [key, outletId] of Object.entries(mappings)) {
                        if (outletId) {
                            await this.dlqDataAccess.updateOutletIdsForStaticKey(appName, key, outletId);
                            // Process the newly mapped messages
                            await this.processOutlet(outletId);
                        }
                    }
                } catch (error) {
                    logger.trackException({ exception: (error as Error), message: `Failed to process static mappings for app ${appName} ` });
                    throw error;
                }
            }
        } catch (error) {
            metricCollector.recordMessageCount(
                'dlq_processing_errors',
                1,
                { attributes: { routing_type: "static" } }
            );
            logger.trackException({ exception: (error as Error), message: `Error while processing static messages:` });
            throw error;
        }
    }

    private async processOutlet(outletId: string): Promise<void> {
        const attributes = { outlet_id: outletId };
        try {
            // 1. Initialize outlet connection (uses shared OutletProducerManager for dedup)
            const producer = await MetricsHelper.recordTiming(
                'dlq_get_or_create_producer',
                () => this.outletProducerManager.getOrCreateProducer(outletId),
                attributes
            );

            // 2. Process messages in batches
            let lastId = '00000000-0000-0000-0000-000000000000'; // Start with lowest possible UUID
            let processedCount = 0;
            let failedCount = 0;
            const startTime = Date.now();

            while (true) {
                // Get batch of messages
                const messages = await MetricsHelper.recordTiming(
                    'dlq_messages_fetch',
                    () => this.dlqDataAccess.getDLQMessages(outletId, lastId, this.batchSize),
                    attributes
                );

                if (messages.length === 0) {
                    break;
                }

                metricCollector.recordMessageCount(
                    'dlq_messages_per_outlet',
                    messages.length,
                    { attributes: attributes }
                );
                // Try to send messages
                if (!producer) {
                    logger.trackException({ message: `Producer initialization failed` });
                    throw new Error('Producer initialization failed');
                }

                const { succeeded, failed } = await MetricsHelper.recordTiming(
                    'dlq_messages_retry',
                    () => this.sendMessages(producer, messages),
                    attributes
                );

                processedCount += succeeded.length;
                failedCount += failed.length;

                // Update retry counts for failed messages
                if (failed.length > 0) {
                    await this.dlqDataAccess.updateMessageRetryCount(
                        failed.map(msg => msg.id.toString())
                    );
                    metricCollector.recordMessageCount(
                        'dlq_messages_failed_to_process',
                        failed.length,
                        { attributes: attributes }
                    );
                    logger.trackException({ message: `DLQ Messages failed` });
                    // Exiting if there are failures
                    break;
                }

                // Mark successful messages as processed
                if (succeeded.length > 0) {
                    await this.dlqDataAccess.markMessagesAsProcessed(
                        succeeded.map(msg => msg.id.toString())
                    );
                    metricCollector.recordMessageCount(
                        'dlq_messages_processed_success',
                        succeeded.length,
                        { attributes: attributes }
                    );
                }

                // Update lastId for next batch
                lastId = messages[messages.length - 1].id.toString();
                logger.trackTrace({
                    message: `Processed ${processedCount} messages, \
                    failed ${failedCount} messages for outlet ${outletId}`
                });
            }

            const processingTime = Date.now() - startTime;
            metricCollector.recordHistogramValue(
                'dlq_outlet_processing_duration_ms',
                processingTime,
                { attributes: attributes }
            );
            logger.trackTrace({ message: `Completed processing outlet ${outletId}. Total processed: ${processedCount}, failed: ${failedCount}` });

        } catch (error) {
            metricCollector.recordMessageCount(
                'dlq_outlet_processing_errors',
                1,
                { attributes: attributes }
            );
            logger.trackException({ exception: (error as Error), message: `Failed to process outlet ${outletId}` });
            throw error;
        }
    }

    private async sendMessages(producer: EqaProducer, messages: DLQEntry[]): Promise<{
        succeeded: DLQEntry[];
        failed: DLQEntry[];
    }> {
        const messageData = messages.map(message => message.data);

        try {
            // Messages are stored with { body, properties } format - pass them through as-is
            await producer.send(messageData.map(data => ({
                body: data.body,
                properties: data.properties || {}
            })));
            return { succeeded: messages, failed: [] };
        } catch (error) {
            logger.trackException({ exception: (error as Error), message: `Failed to send batch of ${messages.length} messages:` });
            return { succeeded: [], failed: messages };
        }
    }

    async close(): Promise<void> {
        await this.outletProducerManager.clear();
    }
}
