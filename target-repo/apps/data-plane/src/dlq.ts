import dotenv from 'dotenv';
dotenv.config();

import { ControlPlaneClient } from './clients/controlPlane.client';
import { DLQService } from './services/dlq.service';
import * as logger from '@motorq/logger';
import config from "./common/config";
import { setConfig } from "@motorq/logger";
import { initializeMetricCollector } from '@motorq/metric-collector';
setConfig({
    logLevel: config.logLevel,
});

initializeMetricCollector({
    appName: `drs-dlq`,
    envPriority: 'P3',
    isMultitenant: true,
    enableMetrics: true,
    metricPrefix: 'drs_dp',
    // metricsPort: 9466 //(uncomment this line if working with both control plane and data plane in the same device)
});
async function main() {

    const controlPlaneClient = new ControlPlaneClient();
    const service = new DLQService(controlPlaneClient);

    process.on('SIGINT', async () => {
        logger.trackTrace({ message: 'Received SIGINT. Shutting down...' })
        await service.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.trackTrace({ message: 'Received SIGTERM. Shutting down...' })
        await service.stop();
        process.exit(0);
    });

    try {
        await service.start();
    } catch (error) {
        logger.trackFatal({ exception: (error as Error), message: "Fatal error" })
        process.exit(1);
    }
}

main().catch(error => {
    logger.trackException({ message: 'Unhandled error:', exception: (error as Error) });
    process.exit(1);
});
