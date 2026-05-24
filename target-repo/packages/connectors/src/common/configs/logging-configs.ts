// Add all configs related to monitoring/logging here (logging, heartbeat, elasticsearch, appinsights, etc.)

const loggingConfigs = {
    aksNodeName: process.env.AKS_NODE_NAME,
    aksNamespace: process.env.AKS_NAMESPACE,
    logLevel: process.env.LOG_LEVEL || "trace",
};




export default loggingConfigs;
