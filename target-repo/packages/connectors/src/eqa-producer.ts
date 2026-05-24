import {
    OutputStream,
    OutputStreamParams
} from '@motorq/event-queue-abstraction';
import * as logger from '@motorq/logger';

/**
 * Thin wrapper around EQA OutputStream
 * NO connector type knowledge - just wraps EQA primitives
 */
export class EqaProducer {
    private outputStream: OutputStream | null = null;
    private initPromise: Promise<void> | null = null;
    private readonly params: OutputStreamParams;

    constructor(params: OutputStreamParams) {
        this.params = params;
    }

    /**
     * Initialize and connect to the output stream
     */
    async connect(): Promise<void> {
        if (this.outputStream) {
            logger.trackTrace({
                message: `Already connected to producer`,
                args: { targetType: this.params.targetType }
            });
            return;
        }

        if (this.initPromise) {
            return await this.initPromise;
        }

        this.initPromise = (async () => {
            const outputStream = new OutputStream(this.params);
            await outputStream.init();
            this.outputStream = outputStream;

            logger.trackTrace({
                message: `Connected to producer`,
                args: { targetType: this.params.targetType }
            });
        })();

        try {
            await this.initPromise;
        } catch (error) {
            this.outputStream = null;
            throw error;
        } finally {
            this.initPromise = null;
        }
    }

    /**
     * Send messages to the output stream
     */
    async send(messages: any[]): Promise<void> {
        await this.connect();

        if (!this.outputStream) {
            throw new Error('Output stream not initialized');
        }

        try {
            // Messages are expected in format: { body, properties }
            // This matches the format from filterer/transformer and base processor
            const events = messages.map(message => ({
                body: message.body,
                properties: message.properties || {}
            }));

            const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            this.outputStream.addToBufferByBatch(events, batchId);
            await this.outputStream.flushBuffer();

        } catch (error) {
            logger.trackException({
                exception: error as Error,
                message: `Failed to send messages`
            });
            throw error;
        }
    }

    /**
     * Get partitions from the output stream
     * Used for EventHub connection validation
     */
    async getPartitions(): Promise<string[]> {
        await this.connect();

        if (!this.outputStream) {
            throw new Error('Output stream not initialized');
        }

        try {
            const client = (this.outputStream as any).client;

            if (!client || typeof client.getPartitions !== 'function') {
                return ['0'];
            }

            return await client.getPartitions();
        } catch (error) {
            logger.trackException({
                exception: error as Error,
                message: `Failed to get partitions`
            });
            throw error;
        }
    }

    async getPartitionCount(): Promise<number> {
        await this.connect();

        if (!this.outputStream) {
            throw new Error('Output stream not initialized');
        }

        try {
            return await this.outputStream.getPartitionCount();
        } catch (error) {
            logger.trackException({
                exception: error as Error,
                message: `Failed to get partition count`
            });
            throw error;
        }
    }

    /**
     * Close the producer
     */
    async close(): Promise<void> {
        try {
            if (this.outputStream) {
                await this.outputStream.flushBuffer();
                await this.outputStream.close();
                this.outputStream = null;
            }
            logger.trackTrace({
                message: `EqaProducer closed successfully`
            });
        } catch (error) {
            logger.trackException({
                exception: error as Error,
                message: 'Error closing EqaProducer'
            });
            throw error;
        }
    }
}
