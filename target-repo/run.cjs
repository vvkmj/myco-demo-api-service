const { KeyVaultLoader } = require("./kv-loader.cjs");
const { v4: uuid } = require("uuid");

// Top level wrapper to ensure await for loading secrets
// Usage        : node runner.js <path>/<to>/<file>.js arg1 arg2
// Will execute : node <path>/<to>/<file>.js arg1 arg2
async function run() {
  // Optional flag to skip fetching secrets from Key Vault
  if (
    process.env.SHOULD_FETCH_KEY_VAULT_SECRETS == null ||
    process.env.SHOULD_FETCH_KEY_VAULT_SECRETS == "true"
  ) {
    trackEvent({ name: "Loading Key Vault Secrets" });
    const keyVaultLoader = KeyVaultLoader.getInstance();
    await keyVaultLoader.load();
    trackEvent({ name: "Loaded Key Vault Secrets" });
  }

  // Clear all cached modules
  Object.keys(require.cache).forEach((key) => {
    delete require.cache[key];
  });

  // Reset process.argv
  trackTrace({
    message: "Original Command line args",
    args: { processArgs: process.argv },
  });
  const AppToLoad = "./" + process.argv[2];
  // Update process arguments
  process.argv.splice(1, 1);
  trackTrace({
    message: "Resetting process.argv to",
    args: { processArgs: process.argv },
  });
  trackEvent({ name: `Loading target app ${AppToLoad}` });
  require(AppToLoad);
}

function trackTrace({ message, args }) {
  console.log(
    JSON.stringify({
      message,
      args,
      logType: "trace",
      tags: [],
      releaseVersion: process.env.RELEASE_VERSION,
      logVersion: "v2",
      logId: uuid(),
      timestamp: new Date().toISOString(),
      pid: process.pid,
    })
  );
}

function trackEvent({ name, args }) {
  console.log(
    JSON.stringify({
      name,
      args,
      logType: "event",
      tags: [],
      releaseVersion: process.env.RELEASE_VERSION,
      logVersion: "v2",
      logId: uuid(),
      timestamp: new Date().toISOString(),
      pid: process.pid,
    })
  );
}

//Excute the wrapper
run();
