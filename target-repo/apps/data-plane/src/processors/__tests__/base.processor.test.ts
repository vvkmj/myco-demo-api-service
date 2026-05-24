import { BaseRoutingProcessor } from '../base.processor';
import { DLQDataAccess } from '../../data-access/dlq.data-access';
import { OutletProducerManager } from '../../services/outletProducerManager.service';
import type { ConsumerEvent } from '@motorq/event-queue-abstraction';

// Mock dependencies
jest.mock('../../data-access/dlq.data-access');
jest.mock('../../services/outletProducerManager.service');
jest.mock('@motorq/logger');
jest.mock('@motorq/metric-collector', () => ({
    getMetricCollector: jest.fn(() => ({
        recordMessageCount: jest.fn(),
        recordHistogramValue: jest.fn(),
        recordGaugeValue: jest.fn()
    }))
}));

// Create concrete test class since BaseRoutingProcessor is abstract
class TestProcessor extends BaseRoutingProcessor {
    async processBatch(messages: ConsumerEvent[]): Promise<void> {
        // Simple implementation for testing
        const messagesByKey = this.groupMessagesByKey(messages);
        await Promise.all(
            Object.entries(messagesByKey).map(([, msgs]) =>
                this.sendToOutlet('outlet-1', msgs)
            )
        );
    }
}

describe('BaseRoutingProcessor - DLQ Failure Behavior', () => {
    let processor: TestProcessor;
    let mockDLQDataAccess: jest.Mocked<DLQDataAccess>;
    let mockOutletProducerManager: jest.Mocked<OutletProducerManager>;
    let mockControlPlaneClient: any;

    beforeEach(() => {
        // Setup mocks
        mockDLQDataAccess = {
            addToDLQ: jest.fn()
        } as any;

        mockOutletProducerManager = {
            getOrCreateProducer: jest.fn()
        } as any;

        mockControlPlaneClient = {};

        // Mock singleton getInstance methods
        (DLQDataAccess.getInstance as jest.Mock).mockReturnValue(mockDLQDataAccess);
        (OutletProducerManager.getInstance as jest.Mock).mockReturnValue(mockOutletProducerManager);

        const mockApp = {
            app_name: 'test-app',
            routing_type: 'STATIC',
            routing_param: 'routingKey',
            inlet: [{ id: 'inlet-1', name: 'test-inlet' }]
        };

        processor = new TestProcessor(mockApp as any, mockControlPlaneClient);
        jest.clearAllMocks();
    });

    it('should propagate error when DLQ write fails (current behavior)', async () => {
        // ARRANGE: Make outlet send fail
        const mockProducer = {
            send: jest.fn().mockRejectedValue(new Error('Outlet connection failed'))
        };
        mockOutletProducerManager.getOrCreateProducer.mockResolvedValue(mockProducer as any);

        // CRITICAL: Make DLQ write ALSO fail
        mockDLQDataAccess.addToDLQ.mockRejectedValue(
            new Error('Cannot read properties of undefined (reading \'send\')')
        );

        const messages: ConsumerEvent[] = [
            { body: { routingKey: 'keyA' }, properties: {} } as any
        ];

        // ACT & ASSERT: sendToOutlet should throw (error propagates)
        await expect(processor.sendToOutlet('outlet-1', messages))
            .rejects.toThrow('Cannot read properties of undefined');

        // VERIFY: Outlet send was attempted
        expect(mockProducer.send).toHaveBeenCalled();

        // VERIFY: DLQ write was attempted
        expect(mockDLQDataAccess.addToDLQ).toHaveBeenCalled();

        // RESULT: Error propagated → batch will retry infinitely
    });

    it('should NOT propagate error when only outlet fails but DLQ succeeds', async () => {
        // ARRANGE: Make outlet send fail
        const mockProducer = {
            send: jest.fn().mockRejectedValue(new Error('Outlet connection failed'))
        };
        mockOutletProducerManager.getOrCreateProducer.mockResolvedValue(mockProducer as any);

        // DLQ write SUCCEEDS
        mockDLQDataAccess.addToDLQ.mockResolvedValue(undefined);

        const messages: ConsumerEvent[] = [
            { body: { routingKey: 'keyA' }, properties: {} } as any
        ];

        // ACT: sendToOutlet should NOT throw (DLQ absorbs the error)
        await expect(processor.sendToOutlet('outlet-1', messages))
            .resolves.not.toThrow();

        // VERIFY: Outlet send was attempted
        expect(mockProducer.send).toHaveBeenCalled();

        // VERIFY: DLQ write succeeded
        expect(mockDLQDataAccess.addToDLQ).toHaveBeenCalled();

        // RESULT: No error propagated → batch processing continues
    });

    it('should demonstrate DLQ retry attempts before final failure', async () => {
        // ARRANGE: Simulate DLQ write failing multiple times
        const mockProducer = {
            send: jest.fn().mockRejectedValue(new Error('Outlet failed'))
        };
        mockOutletProducerManager.getOrCreateProducer.mockResolvedValue(mockProducer as any);

        // DLQ fails on first 2 attempts, succeeds on 3rd
        mockDLQDataAccess.addToDLQ
            .mockRejectedValueOnce(new Error('DLQ connection timeout'))
            .mockRejectedValueOnce(new Error('DLQ connection timeout'))
            .mockResolvedValueOnce(undefined);

        const messages: ConsumerEvent[] = [
            { body: { routingKey: 'keyA' }, properties: {} } as any
        ];

        // ACT: First call fails (DLQ fails)
        await expect(processor.sendToOutlet('outlet-1', messages))
            .rejects.toThrow('DLQ connection timeout');

        // ACT: Second call fails (DLQ fails again)
        await expect(processor.sendToOutlet('outlet-1', messages))
            .rejects.toThrow('DLQ connection timeout');

        // ACT: Third call succeeds (DLQ succeeds)
        await expect(processor.sendToOutlet('outlet-1', messages))
            .resolves.not.toThrow();

        // VERIFY: DLQ was attempted 3 times
        expect(mockDLQDataAccess.addToDLQ).toHaveBeenCalledTimes(3);

        // RESULT: Shows retry behavior at batch level (appInstance retries)
    });
});

describe('BaseRoutingProcessor - Properties Preservation', () => {
    let processor: TestProcessor;
    let mockDLQDataAccess: jest.Mocked<DLQDataAccess>;
    let mockOutletProducerManager: jest.Mocked<OutletProducerManager>;
    let mockControlPlaneClient: any;

    beforeEach(() => {
        // Setup mocks (same as Test 3)
        mockDLQDataAccess = {
            addToDLQ: jest.fn().mockResolvedValue(undefined)
        } as any;

        mockOutletProducerManager = {
            getOrCreateProducer: jest.fn()
        } as any;

        mockControlPlaneClient = {};

        (DLQDataAccess.getInstance as jest.Mock).mockReturnValue(mockDLQDataAccess);
        (OutletProducerManager.getInstance as jest.Mock).mockReturnValue(mockOutletProducerManager);

        const mockApp = {
            app_name: 'test-app',
            routing_type: 'STATIC',
            routing_param: 'routingKey',
            inlet: [{ id: 'inlet-1', name: 'test-inlet' }]
        };

        processor = new TestProcessor(mockApp as any, mockControlPlaneClient);
        jest.clearAllMocks();
    });

    it('should preserve all message properties when routing to DLQ', async () => {
        // ARRANGE: Make outlet send fail to trigger DLQ
        const mockProducer = {
            send: jest.fn().mockRejectedValue(new Error('Outlet connection failed'))
        };
        mockOutletProducerManager.getOrCreateProducer.mockResolvedValue(mockProducer as any);

        // Create message with extensive properties
        const messages: ConsumerEvent[] = [
            {
                body: {
                    routingKey: 'test-key',
                    payload: { id: 123, data: 'test data' }
                },
                properties: {
                    vehicleId: 'VEHICLE-ERROR-123',
                    tenantId: 'TENANT-ERROR-456',
                    customHeader1: 'custom-value-1',
                    customHeader2: 'custom-value-2',
                    timestamp: '2025-01-15T10:30:00Z',
                    correlationId: 'correlation-error-789',
                    messageId: 'msg-001',
                    source: 'integration-test'
                }
            } as any
        ];

        // ACT: Send to outlet (will fail and go to DLQ)
        await processor.sendToOutlet('outlet-1', messages);

        // ASSERT: Verify addToDLQ was called with full message data
        expect(mockDLQDataAccess.addToDLQ).toHaveBeenCalledTimes(1);

        const dlqCall = mockDLQDataAccess.addToDLQ.mock.calls[0];
        const [appName, outletId, inletId, storedMessages] = dlqCall;

        // Verify arguments
        expect(appName).toBe('test-app');
        expect(outletId).toBe('outlet-1');
        expect(inletId).toBe('inlet-1');

        // Verify message structure passed to DLQ
        expect(storedMessages).toHaveLength(1);
        const storedMessage = storedMessages[0];

        // CRITICAL: Verify all properties are preserved
        expect(storedMessage.body).toEqual(messages[0].body);
        expect(storedMessage.properties).toEqual(messages[0].properties);

        // Verify specific properties
        expect(storedMessage.properties.vehicleId).toBe('VEHICLE-ERROR-123');
        expect(storedMessage.properties.tenantId).toBe('TENANT-ERROR-456');
        expect(storedMessage.properties.customHeader1).toBe('custom-value-1');
        expect(storedMessage.properties.customHeader2).toBe('custom-value-2');
        expect(storedMessage.properties.timestamp).toBe('2025-01-15T10:30:00Z');
        expect(storedMessage.properties.correlationId).toBe('correlation-error-789');
        expect(storedMessage.properties.messageId).toBe('msg-001');
        expect(storedMessage.properties.source).toBe('integration-test');
    });

    it('should preserve empty properties object when no properties exist', async () => {
        // ARRANGE
        const mockProducer = {
            send: jest.fn().mockRejectedValue(new Error('Outlet failed'))
        };
        mockOutletProducerManager.getOrCreateProducer.mockResolvedValue(mockProducer as any);

        const messages: ConsumerEvent[] = [
            {
                body: { routingKey: 'test-key', data: 'simple message' },
                properties: {}  // Empty properties
            } as any
        ];

        // ACT
        await processor.sendToOutlet('outlet-1', messages);

        // ASSERT: Verify empty properties object is preserved
        const storedMessages = mockDLQDataAccess.addToDLQ.mock.calls[0][3];
        expect(storedMessages[0].properties).toEqual({});
    });

    it('should preserve undefined properties as empty object', async () => {
        // ARRANGE
        const mockProducer = {
            send: jest.fn().mockRejectedValue(new Error('Outlet failed'))
        };
        mockOutletProducerManager.getOrCreateProducer.mockResolvedValue(mockProducer as any);

        const messages: ConsumerEvent[] = [
            {
                body: { routingKey: 'test-key', data: 'message without properties' }
                // No properties field
            } as any
        ];

        // ACT
        await processor.sendToOutlet('outlet-1', messages);

        // ASSERT: Verify properties becomes empty object
        const storedMessages = mockDLQDataAccess.addToDLQ.mock.calls[0][3];
        expect(storedMessages[0].properties).toEqual({});
    });
});
