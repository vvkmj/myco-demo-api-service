import { App } from '@packages/drs-types';
import { ControlPlaneClient } from '../clients/controlPlane.client';
import { BaseRoutingProcessor } from './base.processor';
import { StickyMappingCache } from '../sticky/stickyMappingCache';
import type { ConsumerEvent } from '@motorq/event-queue-abstraction';
import * as logger from '@motorq/logger';

export class StickyRoutingProcessor extends BaseRoutingProcessor {
    private stickyMappingCache: StickyMappingCache;

    constructor(app: App, controlPlaneClient: ControlPlaneClient) {
        super(app, controlPlaneClient);
        this.stickyMappingCache = StickyMappingCache.getInstance();
    }

    override async processBatch(messages: ConsumerEvent[]): Promise<void> {
        // 1. Group messages by key
        const messagesByKey = this.groupMessagesByKey(messages);

        // 2. Get sticky mappings with cache
        const keyToOutletMap = await this.getStickyMappings(Object.keys(messagesByKey));

        // 3. Group messages by outlet
        const messagesByOutlet = this.groupMessagesByOutlet(messagesByKey, keyToOutletMap);

        // 4. Send to outlets using shared method
        await Promise.all(
            Object.entries(messagesByOutlet).map(([outletId, messages]) =>
                this.sendToOutlet(outletId, messages)
            )
        );
    }

    private async getStickyMappings(keys: string[]): Promise<Record<string, string>> {
        // Check cache first (with app name to prevent cross-app conflicts)
        const { resultMissing } = this.stickyMappingCache.getStickyMappings(this.app.app_name, keys);

        // Get mappings for missing keys
        if (resultMissing.length > 0) {
            try {
                // First try to get existing mappings
                const mappings = await this.controlPlaneClient.createAndGetStickyMappings(
                    this.app.app_name,
                    resultMissing
                );

                // Update cache with existing mappings (with app name)
                Object.entries(mappings).forEach(([key, outletId]) => {
                    this.stickyMappingCache.setStickyMapping(this.app.app_name, key, outletId);
                });

            } catch (error) {
                logger.trackException({ exception: error, message: 'Failed to get sticky mappings:' });
                throw error;
            }
        }

        const finalMappings: Record<string, string> = {}
        this.stickyMappingCache.getStickyMappings(this.app.app_name, keys).resultExisting.forEach((value, key) => {
            finalMappings[key] = value;
        })
        return finalMappings;
    }
}
