# connectors Package Knowledge Doc

> Extends root `KNOWLEDGE.md`. Read that first.

## 1. Purpose & Architecture

Bridges the Control Plane's connector configuration (canonical format) to EQA `InputStream`/`OutputStream` parameters. Also provides:
- PostgreSQL access (`PgDataAccess` singleton pattern)
- Azure Blob Storage for EventHub checkpointing (`blob-maker.ts`)
- Routing hash function (`routing-hash.ts`)

**The 3-layer abstraction:**

```
CredentialNormalizer  →  ConnectorFactory  →  EqaConsumer / EqaProducer
(format transform)       (type intelligence)   (thin EQA wrappers)
```

`EqaConsumer` and `EqaProducer` have **zero connector-type knowledge** — they only know EQA's `InputStream`/`OutputStream`. All type-specific logic lives in `ConnectorFactory`.

---

## 2. Tech Stack & Key Versions

- `@motorq/event-queue-abstraction@^1.6.2` — EQA library (EventHub + Pulsar unified abstraction)
- `@azure/storage-blob@^12.29.1` — Blob Storage for EventHub checkpointing
- `knex@^3.1.0` + `pg@^8.16.0` — Postgres
- `jsonwebtoken@^9.0.3` — Pulsar JWT token parsing
- `string-hash@^1.1.3` — routing partition hash function

**Note on patches:** No patch file exists for the current EQA version (`^1.6.2`). If you see `patches/@motorq+event-queue-abstraction+*.patch` mentioned in docs, check whether it actually exists before assuming it's applied.

---

## 3. Structure

```
src/
  connector-factory.ts       # Type-aware param building — THE extension point for new connectors
  eqa-consumer.ts            # Thin EQA InputStream wrapper (no type knowledge)
  eqa-producer.ts            # Thin EQA OutputStream wrapper (no type knowledge)
  credential-normalizer.ts   # Control plane canonical → EQA format conversion
  routing-hash.ts            # Partition hash wrapper (string-hash library)
  blob-maker.ts              # Azure Blob checkpoint store creation
  pg-data-access.ts          # Knex singleton with getInstance() keyed by instanceKey
  index.ts                   # Public API exports + logger init

__tests__/
  connector-factory.test.ts  # Comprehensive: consumer/producer creation, JWT parsing, cache key derivation
```

---

## 4. ConnectorFactory — The Only Extension Point

`ConnectorFactory` is the **only place** that knows about connector types (EventHub vs Pulsar). All new connector support goes here.

**Public API:**
- `createConsumer(connector, overrides?)` → `EqaConsumer`
- `createProducer(connector, overrides?)` → `EqaProducer`
- `validateEventHubConnection(connector)` — creates+inits+closes a producer; 5s timeout at call site
- `validatePulsarConnection(connector)` — same pattern; 30s timeout at call site
- `deriveOutputStreamKey(connector)` — deterministic cache key for producer deduplication

**To add a new connector type (e.g. Kafka):**
1. Add `buildKafkaConsumerParams(connector): InputStreamParams`
2. Add `buildKafkaProducerParams(connector): OutputStreamParams`
3. Update `createConsumer()` and `createProducer()` type dispatch
4. Update `deriveOutputStreamKey()` — **required** or it throws "Unsupported connector type"
5. Add new `ConnectorType` to `@packages/drs-types` and update type guards
6. **Do not touch** `EqaConsumer`, `EqaProducer`, or `CredentialNormalizer`

---

## 5. Credential Flow

```
Control Plane canonical format
        ↓
CredentialNormalizer.normalizeConnector()
        ↓
ConnectorFactory builds EQA params
        ↓
EqaConsumer / EqaProducer wraps EQA InputStream/OutputStream
```

**EventHub canonical format** (control plane stores this):
```typescript
{ connectionString: string, entityPath: string, consumerGroup: string }
```
`CredentialNormalizer` splits this into:
- EQA credential: `{ eventHubConnectionString }` (combined conn string with entity path)
- EQA config: `{ eventHub: entityPath, consumerGroup, ...existingConfig }`

**Pulsar**: credential is pass-through (`pulsarServiceUrl`, `pulsarAccessToken` — no transformation).

---

## 6. Hardcoded Behaviors (Not Configurable)

| Behavior | Value | Where |
|----------|-------|-------|
| Pulsar subscription type | `'Failover'` | `connector-factory.ts:buildPulsarConsumerParams()` |
| EventHub producer compression | `'LZ4'` | `connector-factory.ts:buildEventHubProducerParams()` |
| EventHub partition routing key | `partitionKey \|\| vId \|\| vehicleId \|\| 'default'` | `connector-factory.ts:buildEventHubProducerParams()` |

**These field names must not change without coordinating with all message producers:**
`partitionKey`, `vId`, `vehicleId` are extracted from `event.body` for partition routing.

---

## 7. Pulsar JWT Auto-Prefixing

`ConnectorFactory` auto-prefixes Pulsar subscription names with the StreamNative service account from the JWT token.

- Claims to extract: `https://streamnative.io/username` (StreamNative-specific claim)
- Empty/missing/whitespace token → **no prefix** (correct behavior for local Docker dev)
- Slashes in service account → replaced with `_`
- JWT parse failure → **silent** (try-catch returns null, no error thrown)
- Tests: `extractServiceAccountFromToken()` has comprehensive test coverage in `connector-factory.test.ts`

---

## 8. `deriveOutputStreamKey` Format

Used by `OutletProducerManager` in Data Plane for producer connection deduplication. Format:

- EventHub: `EVENTHUB|{entityPath}|{sha256(connectionString).slice(0,16)}`
- Pulsar: `PULSAR|{serviceUrl}|{topic}|{sha256(accessToken).slice(0,16)}`

Raw secrets **never appear** in the key. Must add a case for every supported `ConnectorType` or throws on unsupported type.

---

## 9. Known Tech Debt

**`eqa-producer.ts:getPartitions()`:**
```typescript
(this.outputStream as any).client.getPartitions()
```
Unsafe cast. Returns `['0']` as fallback if `client` doesn't have `getPartitions`. Brittle against EQA internal refactors.

**`pg-data-access.ts:excecuteRaw()`:**
Typo in public method name (extra 'c'). Do not fix without updating all callers — it's a breaking change to the module's API.

---

## 10. What Good Code Looks Like

**Adding consumer support for a new type — only touch ConnectorFactory:**
```typescript
// connector-factory.ts
static createConsumer(connector: Connector, overrides?: Partial<InputStreamParams>): EqaConsumer {
  let params: InputStreamParams;
  if (connector.type === ConnectorType.EVENTHUB) {
    params = this.buildEventHubConsumerParams(connector);
  } else if (connector.type === ConnectorType.PULSAR) {
    params = this.buildPulsarConsumerParams(connector);
  } else if (connector.type === ConnectorType.KAFKA) {  // new
    params = this.buildKafkaConsumerParams(connector);
  } else {
    throw new Error(`Unsupported connector type: ${connector.type}`);
  }
  return new EqaConsumer({ ...params, ...overrides });
}
```

---

## 11. Anti-Patterns

| Anti-pattern | Why wrong |
|-------------|-----------|
| `new EqaConsumer(params)` outside ConnectorFactory | ConnectorFactory sets required defaults; direct instantiation skips them |
| Adding connector-type logic to `EqaConsumer` or `EqaProducer` | These are type-agnostic wrappers — type logic belongs in ConnectorFactory |
| Reading raw credentials from `connector.credential` | Credentials may be null (KeyVault mode); use ConnectorService in Control Plane |
| Hardcoding subscription type in new code | Check current hardcoded value in ConnectorFactory; changing it affects all Pulsar consumers |
| Assuming `getPartitions()` returns real data | Falls back to `['0']` — treat partition count as approximate |

---

## For Review

### MUST FIX — blocks merge
- New connector type not added to `deriveOutputStreamKey()` (will throw at runtime)
- `new EqaConsumer(...)` or `new EqaProducer(...)` instantiated outside `ConnectorFactory`
- Connector-type-specific logic added to `EqaConsumer` or `EqaProducer`
- JWT parse failure surfaces as thrown error (must be silent / return null)

### SHOULD FIX
- New connector type without tests for `deriveOutputStreamKey()` determinism
- Raw credential logged anywhere (would expose secrets)
- `partitionKey`/`vId`/`vehicleId` field names changed without producer coordination

### Testing Requirements
- `connector-factory.test.ts` must cover new connector type for both consumer and producer creation
- Test `deriveOutputStreamKey()` determinism: same inputs → same key, different inputs → different key
- Mock EQA library (`@motorq/event-queue-abstraction`) and Azure SDK in unit tests
