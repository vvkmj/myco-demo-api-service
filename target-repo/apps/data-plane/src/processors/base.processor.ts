import { App } from '@packages/drs-types';
import { ControlPlaneClient } from '../clients/controlPlane.client';
import { DLQDataAccess } from '../data-access/dlq.data-access';
import { MetricsHelper } from '../common/metrics';
import { getMetricCollector } from '@motorq/metric-collector';
import { EqaProducer } from '@packages/connectors';
import { OutletProducerManager } from '../services/outletProducerManager.service';
import { extractRoutingKey, RoutingKey, RoutableMessage } from '../common/message.utils';
import type { ConsumerEvent } from '@motorq/event-queue-abstraction';
import * as logger from '@motorq/logger';

const metricCollector = getMetricCollector();
export abstract class BaseRoutingProcessor {
    protected dlqDataAccess: DLQDataAccess;
    protected outletProducerManager: OutletProducerManager;
    
    constructor(
        protected readonly app: App,
        protected readonly controlPlaneClient: ControlPlaneClient
    ) {
        this.dlqDataAccess = DLQDataAccess.getInstance();
        // Initialize outlet producer manager with TTL-based invalidation for outlet configuration updates
        this.outletProducerManager = OutletProducerManager.getInstance(controlPlaneClient);
    }

    getAppName(): string {
        return this.app.app_name;
    }

    getRoutingType(): string {
        return this.app.routing_type;
    }

    abstract processBatch(messages: ConsumerEvent[]): Promise<void>;

    protected groupMessagesByKey(messages: ConsumerEvent[]): Record<string, ConsumerEvent[]> {
        const attributes = {
            app_name: this.getAppName(),
            routing_type: this.getRoutingType()
        };

        let discardedCount = 0;

        const result: Record<string, ConsumerEvent[]> = {}
        for (const message of messages) {
            const key = this.getMessageKey(message);
            // Filter out messages with undefined routing keys
            if (key === undefined || key === null || key === '') {
                // Log the discarded message with details (excluding sensitive data)
                logger.trackTrace({
                    message: `UNDEFINED_ROUTING_KEY: ${this.getAppName()}`,
                    args: {
                        app_name: this.getAppName(),
                        routing_type: this.getRoutingType(),
                        routing_param: this.app.routing_param,
                        sequenceNumber: message.sequenceNumber || 'unknown',
                        body: message.body // Log the body for debugging, but be cautious with sensitive data
                    }
                });
                discardedCount++;
            } else {
                if (!result[key]) {
                    result[key] = [];
                }
                result[key].push(message);
            }
        }
        
        // Record metrics for discarded messages
        if (discardedCount > 0) {
            metricCollector.recordMessageCount(
                'messages_discarded_undefined_routing_key',
                discardedCount,
                { attributes: attributes }
            );
        }

        
        const numUniqueKeys = Object.keys(result).length;

        metricCollector.recordGaugeValue(
            'messages_in_batch',
            Object.keys(result).length,
            { attributes: attributes }
        )

        metricCollector.recordGaugeValue(
            'unique_keys_in_batch',
            numUniqueKeys,
            { attributes: attributes }
        );
        return result;
    }

    protected getMessageKey(message: RoutableMessage): RoutingKey {
        return extractRoutingKey(message, this.app.routing_param);
    }

    protected groupMessagesByOutlet(
        messagesByKey: Record<string, ConsumerEvent[]>,
        keyToOutletMap: Record<string, string>
    ): Record<string, ConsumerEvent[]> {
        const result: Record<string, ConsumerEvent[]> = {};

        for (const [key, messages] of Object.entries(messagesByKey)) {
            const outletId = keyToOutletMap[key] || 'dlq';
            if (!result[outletId]) {
                result[outletId] = [];
            }
            result[outletId].push(...messages);
        }

        return result;
    }

    protected async outletSender(outletId: string, messages: ConsumerEvent[]): Promise<void> {
        const attributes = {
            app_name: this.getAppName(),
            routing_type: this.getRoutingType(),
            outlet_id: outletId
        };

        if (outletId === 'dlq') {
            logger.trackException({ message: 'Messages were not mapped to any outlet' });
            throw new Error('Messages were not mapped to any outlet');
        }

        const producer = await MetricsHelper.recordTiming(
            'get_or_create_producer',
            () => this.getOrCreateProducer(outletId),
            attributes
        );
        await producer.send(messages.map(m => ({
            body: m.body,
            properties: m.properties || {}
        })));
        metricCollector.recordMessageCount(
            'messages_sent_to_outlet',
            messages.length,
            { attributes: attributes });
    }

    protected async sendToDLQ(outletId: string, messages: ConsumerEvent[], error: Error): Promise<void> {
        const attributes = {
            app_name: this.getAppName(),
            routing_type: this.getRoutingType(),
            outlet_id: outletId
        };
        await MetricsHelper.recordTiming(
            'dlq_add',
            () => this.dlqDataAccess.addToDLQ(
                this.app.app_name,
                outletId,
                this.app.inlet[0].id,
                messages.map(m => ({ body: m.body, properties: m.properties || {} })),
                error as Error
            ),
            attributes
        );
        metricCollector.recordMessageCount(
            'messages_sent_to_dlq',
            messages.length,
            { attributes: attributes });
    }

    public async sendToOutlet(outletId: string, messages: ConsumerEvent[]): Promise<void> {
        const attributes = {
            app_name: this.getAppName(),
            routing_type: this.getRoutingType(),
            outlet_id: outletId
        };
        try {
            await MetricsHelper.recordTiming(
                'outlet_send',
                async () => {
                    await this.outletSender(outletId, messages);
                },
                attributes
            );
        }
        catch (error) {
            logger.trackException({ exception: (error as Error), message: `Error while sending messages to outlet`, args: {outletId: outletId} });
            await this.sendToDLQ(outletId, messages, error as Error);
        }
    }

    protected async getOrCreateProducer(outletId: string): Promise<EqaProducer> {
        const attributes = {
            app_name: this.getAppName(),
            routing_type: this.getRoutingType(),
            outlet_id: outletId
        };

        try {
            // Use OutletProducerManager which handles TTL-based invalidation for outlet config changes
            return await MetricsHelper.recordTiming(
                'get_or_create_producer_with_manager',
                () => this.outletProducerManager.getOrCreateProducer(outletId),
                attributes
            );
        } catch (error) {
            // Log outlet not found for monitoring
            if (error instanceof Error && error.message.includes('not found')) {
                metricCollector.recordMessageCount(`outlet_not_found`, 1, { attributes });
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        // Clear the outlet producer manager which will close all producer connections
        await this.outletProducerManager.clear();
    }
}