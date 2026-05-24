const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");
const { v4: uuid } = require("uuid");
const _ = require("lodash");

const keyVersionTokenizer = "/";

class KeyVaultLoader {
  kvSecretClients = new Map();
  instance = null;

  static getInstance() {
    if (!this.instance) {
      let keyVaultLoader = new KeyVaultLoader();
      this.instance = keyVaultLoader;
      this.instance.init();
    }
    return this.instance;
  }

  async load() {
    const SECRET_PREFIX = process.env.SECRETPREFIX;
    const keys = [];
    _.each(process.env, (value, key) => {
      if (key.startsWith(SECRET_PREFIX)) {
        const [keyVault, version] = value.split(keyVersionTokenizer);
        const keyObj = {
          key: key.replace(SECRET_PREFIX, ""),
          version,
          keyVault,
        };
        keys.push(keyObj);
      }
    });
    try {
      await this.loadKeyVaultSecrets(keys);
    } catch (err) {
      trackException({
        exception: err,
        message: "KeyVaultLoader.load() failed",
      });
      process.exit(-1);
    }
    return keys;
  }

  async loadKeyVaultSecrets(keys) {
    try {
      const batchSize = 20;
      for (var i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        const promises = batch.map(async (keyObj) => {
          const { key, version, keyVault } = keyObj;
          //! Azure Key Vault Doesn't support Underscore in Secret names replacing with hypen
          const value = await this.getSecret(
            key.split("_").join("-"),
            keyVault,
            version
          );
          process.env[key] = value;
        });
        promises.push(
          new Promise((resolve) => {
            setTimeout(resolve, 1000);
          })
        );
        await Promise.all(promises);
      }
    } catch (err) {
      trackException({
        exception: err,
        message: "Loading Key Vault Secrets Failed",
      });
      throw err;
    }
  }

  init() {
    const SECRET_PREFIX = process.env.SECRETPREFIX;
    _.each(process.env, (value, key) => {
      if (key.startsWith(SECRET_PREFIX)) {
        const [keyVault] = value.split(keyVersionTokenizer);
        const kvUri = "https://" + keyVault + ".vault.azure.net";
        const credential = new DefaultAzureCredential();
        const client = new SecretClient(kvUri, credential);
        this.kvSecretClients[keyVault] = client;
      }
    });
  }

  async getSecret(keyName, keyVault, version) {
    let result = null;
    const client = this.kvSecretClients[keyVault];
    try {
      let data;
      if (version) {
        data = await client.getSecret(keyName, { version: version });
      } else {
        data = await client.getSecret(keyName);
      }
      if (!_.isNil(data)) {
        result = data.value;
      }
    } catch (err) {
      trackException({
        exception: err,
        message: "Unable to get secret",
        args: { keyVault, keyName, version },
      });
      throw err;
    }
    return result;
  }
}

function trackException({ exception, message, args }) {
  console.error(
    JSON.stringify({
      message,
      parsedException: _.pick(exception, ["name", "message", "stack"]),
      args,
      logType: "error",
      tags: [],
      releaseVersion: process.env.RELEASE_VERSION,
      logVersion: "v2",
      logId: uuid(),
      timestamp: new Date().toISOString(),
      pid: process.pid,
    })
  );
}

module.exports = { KeyVaultLoader, keyVersionTokenizer };
