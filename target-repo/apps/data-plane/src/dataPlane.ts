import dotenv from 'dotenv';
dotenv.config();
import { ControlPlaneClient } from './clients/controlPlane.client';
import { DataPlaneService } from './services/dataPlane.service';
import { getMetricCollector, initializeMetricCollector } from '@motorq/metric-collector';
import * as logger from '@motorq/logger';
import config from "./common/config";
import { setConfig } from "@motorq/logger";

setConfig({
    logLevel: config.logLevel,
});
initializeMetricCollector({
    appName: `drs-data-plane`,
    envPriority: 'P3',
    isMultitenant: true,
    enableMetrics: true,
    metricPrefix: 'drs_dp',
    // metricsPort: 9465 //(uncomment this line if working with both control plane and data plane in the same device)
});

const metricCollector = getMetricCollector();
async function main() {
    // Get app names from command line args or environment
    const appNames = process.argv.slice(2).length > 0
        ? process.argv.slice(2)
        : process.env.DATA_PLANE_APPS_TO_ROUTE?.split(',') || [];

    if (appNames.length === 0) {
        logger.trackException({ message: 'Please provide at least one app name as an argument or in DATA_PLANE_APPS_TO_ROUTE environment variable' });
        process.exit(1);
    }

    //Initialize metrics for each app
    appNames.forEach(appName => {
        metricCollector.recordMessageCount(`service_start`, 1, { attributes: { app_name: appName } });
    });
    const controlPlaneClient = new ControlPlaneClient();
    const service = new DataPlaneService(controlPlaneClient);

    // Handle shutdown signals
    const handleShutdown = async (signal: string) => {
        logger.trackTrace({ message: `Received ${signal}. Shutting down...` });
        appNames.forEach(appName => {
            metricCollector.recordMessageCount(
                'service_stop',
                1,
                { attributes: { app_name: appName, signal: signal } });
        });
        await service.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    try {
        await service.start(appNames)
    } catch (error) {
        const err = error as Error;
        logger.trackFatal({ exception: err, message: `Fatal error while running services:` });
        process.exit(1);
    }
}

main().catch(error => {
    logger.trackException({ exception: (error as Error), message: `Unhandled error in the data plane` });
    process.exit(1);
});