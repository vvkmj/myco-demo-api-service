import config from "./common/configs/config";
import { setConfig } from "@motorq/logger";
setConfig({
    logLevel: config.logLevel,
});

// Export EQA-based connectors (unified abstraction for EventHub, Pulsar, and future connectors)
export { EqaConsumer } from './eqa-consumer';
export { EqaProducer } from './eqa-producer';
export { ConnectorFactory } from './connector-factory';
export { CredentialNormalizer } from './credential-normalizer';

// Export utilities
export * from './blob-maker';
export * from './pg-data-access';
export * from './routing-hash';
