import { App } from '@packages/drs-types';
import { ControlPlaneClient } from '../clients/controlPlane.client';
import { BaseRoutingProcessor } from './base.processor';
import { StaticMappingCache } from '../static/staticMappingCache';
import { MetricsHelper } from "../common/metrics";
import { getMetricCollector } from '@motorq/metric-collector';
import type { ConsumerEvent } from '@motorq/event-queue-abstraction';
import * as logger from '@motorq/logger';

const metricCollector = getMetricCollector();
export class StaticRoutingProcessor extends BaseRoutingProcessor {
    private staticMappingCache: StaticMappingCache;

    constructor(app: App, controlPlaneClient: ControlPlaneClient) {
        super(app, controlPlaneClient);
        this.staticMappingCache = StaticMappingCache.getInstance();
    }

    override async processBatch(messages: ConsumerEvent[]): Promise<void> {
        // 1. Group messages by key
        const messagesByKey = this.groupMessagesByKey(messages);

        // 2. Get static mappings
        const keyToOutletMap = await this.getStaticMappings(Object.keys(messagesByKey));

        // 3. Group messages by outlet
        const messagesByOutlet = this.groupMessagesByOutlet(messagesByKey, keyToOutletMap);

        // 4. Send to outlets using shared method
        await Promise.all(
            Object.entries(messagesByOutlet).map(([outletId, messages]) =>
                this.sendToOutlet(outletId, messages)
            )
        );
    }

    private async getStaticMappings(keys: string[]): Promise<Record<string, string>> {
        // Check cache first (with app name to prevent cross-app conflicts)
        const { resultMissing } = this.staticMappingCache.getStaticMappings(this.app.app_name, keys);

        // Get mappings for missing keys
        if (resultMissing.length > 0) {
            try {
                const mappings = await this.controlPlaneClient.getStaticMappings(
                    this.app.app_name,
                    resultMissing
                );

                // Update cache with fetched mappings (with app name)
                Object.entries(mappings).forEach(([key, outletId]) => {
                    this.staticMappingCache.setStaticMapping(this.app.app_name, key, outletId);
                });

            } catch (error) {
                metricCollector.recordMessageCount('get_static_mapping_errors', 1);
                logger.trackException({ exception: error, message: `Failed to get static mappings` });
                throw error;
            }
        }

        const finalMappings: Record<string, string> = {}
        this.staticMappingCache.getStaticMappings(this.app.app_name, keys).resultExisting.forEach((value, key) => {
            finalMappings[key] = value;
        })
        return finalMappings;
    }


    async sendToDLQ(outletId: string, messages: ConsumerEvent[], error: Error): Promise<void> {
        const attributes = {
            app_name: this.getAppName(),
            routing_type: this.getRoutingType(),
            outlet_id: outletId
        };
        logger.trackException({ exception: error, message: `Error while sending messages to static outlet, so sending to DLQ` });

        await MetricsHelper.recordTiming(
            'dlq_add',
            () => this.dlqDataAccess.addToDLQ(
                this.app.app_name,
                outletId,
                this.app.inlet[0].id,
                messages.map(m => ({ body: m.body, properties: m.properties || {} })),
                error as Error,
                this.app.routing_param
            ),
            attributes
        );
        metricCollector.recordMessageCount(
            'messages_sent_to_dlq', messages.length, {
            attributes: attributes
        });
    }
}
