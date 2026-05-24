import { PartitionContext, ReceivedEventData } from '@azure/event-hubs';
import { ControlPlaneClient } from '../clients/controlPlane.client';
import { App, Outlet } from '@packages/drs-types';
import { DLQDataAccess } from '../data-access/dlq.data-access';
import { EqaProducer, ConnectorFactory } from '@packages/connectors';
import * as logger from '@motorq/logger';

export interface MessageProcessor {
	processBatch(messages: ReceivedEventData[], context: PartitionContext): Promise<void>;
}

export class MessageProcessorImpl implements MessageProcessor {
	private producers: Map<string, EqaProducer> = new Map();
	private dlqDataAccess: DLQDataAccess;

	constructor(
		private readonly app: App,
		private readonly controlPlaneClient: ControlPlaneClient
	) {
		this.dlqDataAccess = DLQDataAccess.getInstance();
	}

	// @ts-ignore
	async processBatch(messages: ReceivedEventData[], context: PartitionContext): Promise<void> {
		try {
			// 1. Group messages by key
			const messagesByKey = this.groupMessagesByKey(messages);

			// 2. Get outlet mappings for keys
			const keyToOutletMap = await this.getOutletMappings(Object.keys(messagesByKey));

			// 3. Group messages by outlet
			const messagesByOutlet = this.groupMessagesByOutlet(messagesByKey, keyToOutletMap);

			// 4. Send messages to outlets in parallel
			await Promise.all(
				Object.entries(messagesByOutlet).map(([outletId, messages]) =>
					this.sendToOutlet(outletId, messages)
				)
			);
		} catch (error) {
			logger.trackException({ exception: error, message: 'Error processing batch:' });
			throw error;
		}
	}

	// @ts-ignore
	private async getOutletMappings(keys: string[]): Promise<Record<string, string>> {
		throw new Error('Method not implemented. Please use StaticRoutingProcessor or StickyRoutingProcessor for specific routing logic.');
	}

	private groupMessagesByKey(messages: ReceivedEventData[]): Record<string, ReceivedEventData[]> {
		return messages.reduce((acc, message) => {
			const key = this.getMessageKey(message);
			if (!acc[key]) {
				acc[key] = [];
			}
			acc[key].push(message);
			return acc;
		}, {} as Record<string, ReceivedEventData[]>);
	}

	private getMessageKey(message: ReceivedEventData): string {
		const body = message.body as any;
		const routingParam = this.app.routing_param;
		return body[routingParam] || 'default';
	}

	private groupMessagesByOutlet(
		messagesByKey: Record<string, ReceivedEventData[]>,
		keyToOutletMap: Record<string, string>
	): Record<string, ReceivedEventData[]> {
		const result: Record<string, ReceivedEventData[]> = {};

		for (const [key, messages] of Object.entries(messagesByKey)) {
			const outletId = keyToOutletMap[key] || 'dlq';
			if (!result[outletId]) {
				result[outletId] = [];
			}
			result[outletId].push(...messages);
		}

		return result;
	}

	private async sendToOutlet(outletId: string, messages: ReceivedEventData[]): Promise<void> {
		try {
			if (outletId === 'dlq') {
				throw new Error('Messages were not mapped to any outlet, proceeding to DLQ')
			}
			const producer = await this.getOrCreateProducer(outletId);
			await producer.send(messages.map(m => m.body));
		} catch (error) {
			logger.trackException({ exception: error, message: `Failed to send to outlet ${outletId}:` });
			await this.dlqDataAccess.addToDLQ(
				this.app.app_name,
				outletId,
				this.app.inlet[0].id,
				messages.map(m => ({ body: m.body, properties: m.properties || {} })),
				error as Error
			);
		}
	}

	private async getOrCreateProducer(outletId: string): Promise<EqaProducer> {
		let producer = this.producers.get(outletId);
		if (!producer) {
			const outlet = await this.findOutlet(outletId);
			if (!outlet) {
				throw new Error(`Outlet ${outletId} not found`);
			}

			// Create producer with auto-detected partition count
			producer = await ConnectorFactory.createProducer(outlet.connector);
			this.producers.set(outletId, producer);
		}
		return producer;
	}

	private async findOutlet(outletId: string): Promise<Outlet | undefined> {
		// First check in app's outlets
		const outlet = this.app.outlets?.find(o => o.id === outletId);
		if (outlet) return outlet;

		// If not found, fetch from control plane
		const outlets = await this.controlPlaneClient.getOutletDetails([outletId]);
		return outlets[0];
	}

	async close(): Promise<void> {
		await Promise.all(
			Array.from(this.producers.values()).map(producer => producer.close())
		);
		this.producers.clear();
	}
}
