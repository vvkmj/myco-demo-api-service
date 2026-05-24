import {
    InputStream,
    InputStreamParams
} from '@motorq/event-queue-abstraction';
import * as logger from '@motorq/logger';

/**
 * Thin wrapper around EQA InputStream
 * NO connector type knowledge - just wraps EQA primitives
 */
export class EqaConsumer {
    private inputStream: InputStream | null = null;
    private currentBatchId: string | null = null;
    private readonly params: InputStreamParams;

    constructor(params: InputStreamParams) {
        this.params = params;
    }

    /**
     * Initialize the input stream
     */
    async init(): Promise<void> {
        this.inputStream = new InputStream(this.params);
        await this.inputStream.init();

        logger.trackTrace({
            message: `EQA InputStream initialized`,
            args: { sourceType: this.params.sourceType }
        });
    }

    /**
     * Get the next batch of events
     */
    async getCurrentBatch(): Promise<any> {
        if (!this.inputStream) {
            throw new Error('Consumer not initialized. Call init() first.');
        }

        const batch = await this.inputStream.getCurrentBatch();
        this.currentBatchId = batch?.batchId || null;

        logger.trackDebug({
            message: `[EqaConsumer] getCurrentBatch() returned`,
            args: {
                sourceType: this.params.sourceType,
                hasBatch: !!batch,
                batchId: batch?.batchId,
                eventCount: batch?.events?.length || 0
            }
        });

        return batch;
    }

    /**
     * Checkpoint the current batch
     */
    async checkpointCurrentBatch(): Promise<void> {
        if (!this.inputStream) {
            logger.trackTrace({ message: '[EqaConsumer] Cannot checkpoint - consumer not initialized' });
            return;
        }

        await this.inputStream.checkpointCurrentBatch();

        logger.trackTrace({
            message: `[EqaConsumer] checkpoint() completed`,
            args: {
                sourceType: this.params.sourceType,
                batchId: this.currentBatchId
            }
        });
    }

    /**
     * Close the consumer
     */
    async close(): Promise<void> {
        try {
            logger.trackTrace({
                message: `[EqaConsumer] Closing consumer...`,
                args: { sourceType: this.params.sourceType }
            });

            if (this.inputStream) {
                await this.inputStream.close();
                this.inputStream = null;
            }

            logger.trackTrace({ message: `[EqaConsumer] Consumer closed successfully` });
        } catch (error) {
            logger.trackException({
                exception: error as Error,
                message: 'Error closing EqaConsumer'
            });
            throw error;
        }
    }
}
