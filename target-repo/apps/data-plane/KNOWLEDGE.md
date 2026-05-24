# Data Plane Knowledge Doc

> Extends root `KNOWLEDGE.md`. Read that first.

## 1. Purpose & Architecture

Consumes messages from inlet event streams (EventHub or Pulsar), applies routing rules fetched from the Control Plane, and delivers messages to outlet streams. Manages a Dead Letter Queue (DLQ) for messages that fail delivery.

**One AppInstance per app name** — the Data Plane is started with explicit app names. Each instance independently manages its consumer, processor, and outlet producers.

---

## 2. Tech Stack & Key Versions

- Node.js 22, TypeScript
- `@packages/connectors` — all broker interaction (EventHub + Pulsar via EQA)
- `@packages/drs-types` — shared entity types
- `axios 1.12.0` — pinned; for Control Plane HTTP calls
- `@motorq/metric-collector` — metrics (prefix: `drs_dp`)
- `@motorq/logger` — structured logging
- PostgreSQL via Knex (DLQ + sticky state)

---

## 3. Structure

```
src/
  dataPlane.ts                      # Entry point — parses app names, handles signals
  dlq.ts                            # DLQ service entry point
  services/
    appInstance.ts                  # Per-app consumer lifecycle + processing loop
    dataPlane.service.ts            # Manages map of AppInstances + cleanup interval
    dlq.service.ts                  # DLQ retry polling loop
    outletProducerManager.service.ts# Producer connection cache (dual-TTL)
    auth.service.ts                 # Azure AD token management for CP auth
  processors/
    base.processor.ts               # Abstract base: grouping, outlet dispatch, DLQ fallback
    static.processor.ts             # STATIC routing: key→outlet from static mapping cache
    sticky.processor.ts             # STICKY routing: key→outlet from sticky mapping cache
    dlq.processor.ts                # DLQ retry: re-routes failed messages to outlets
    message.processor.ts            # Legacy (superseded by base.processor.ts)
  clients/
    controlPlane.client.ts          # Axios wrapper for Control Plane API
  data-access/                      # DLQ + sticky DB access
  static/
    staticMappingCache.ts           # TTL-based static mapping cache (30 min)
  sticky/
    stickyMappingCache.ts           # No-TTL sticky mapping cache (persists per process)
  common/
    config.ts                       # All env config with defaults
    metrics.ts                      # recordTiming<T>() wrapper
    message.utils.ts
    logging-configs.ts
```

---

## 4. Processing Loop (`appInstance.ts`)

The core of the Data Plane. Each AppInstance runs this loop:

```
1. getCurrentBatch()              → poll EQA consumer (1s sleep if empty)
2. processor.processBatch()       → route messages to outlets
3. consumer.checkpointCurrentBatch() → EventHub: advance offset; Pulsar: no-op (auto-ack)
4. On error: log + sleep 1s + retry (no exponential backoff)
```

**At-least-once delivery**: checkpoint happens AFTER processing. A crash between step 2 and step 3 causes the batch to be reprocessed on restart.

**Startup sequence:**
1. Fetch app config from Control Plane (fail fast if no inlets or no outlets)
2. Initialize consumer (EventHub: sets checkpoint container = `{appName}-eventHub`)
3. Select processor based on `routing_type` (`STICKY` → StickyRoutingProcessor, `STATIC` → StaticRoutingProcessor)
4. `startProcessing()` starts in background (fire-and-forget with `.catch()` for logging)
5. On start failure: `stop()` is called before error propagates

**Shutdown:** Sets `isRunning = false`, waits 2 seconds for the loop to exit, then closes consumer and processor.

---

## 5. Processor Extension Pattern (CRITICAL)

Adding a new routing strategy:

1. Create new class in `processors/` extending `BaseRoutingProcessor`
2. Implement `processBatch(messages)` — call `groupMessagesByKey()`, resolve mappings, call `groupMessagesByOutlet()`, send
3. Register in `appInstance.ts` — the only place where `routing_type` dispatches to a processor
4. **Never modify** `base.processor.ts` for a single routing type's needs

`BaseRoutingProcessor` provides:
- `groupMessagesByKey(messages)` — extracts `routing_param` field; silently discards messages with null/undefined/empty key (metric recorded, no DLQ)
- `groupMessagesByOutlet(byKey, mapping)` — unmapped keys → `'dlq'` fallback
- `outletSender(outletId, messages)` — sends via OutletProducerManager; DLQ destination rejected here
- `sendToOutlet(outletId, messages)` — catches send errors, calls `sendToDLQ()` on failure
- `getOrCreateProducer(outletId)` — always use this, never create producers directly

**Silent message discard**: Messages where `routing_param` is undefined/null/empty are dropped with a metric. This is intentional — they cannot be routed and DLQ would not help. Log level: warn.

---

## 6. Caching Behavior

| Cache | TTL | On miss |
|-------|-----|---------|
| `StaticMappingCache` | 30 min | Fetch from Control Plane |
| `StickyMappingCache` | **None** (no TTL) | `createAndGetStickyMappings()` on Control Plane — creates if missing |
| `outletCache` (OutletProducerManager) | 30 min | Fetch outlet from Control Plane |
| `producerCache` (OutletProducerManager) | 30 min | Create new EQA producer |

**Sticky cache has no TTL** — once a key is mapped to an outlet, that mapping lives in memory until process restart. This guarantees the "sticky" invariant within a process lifetime. DB-backed via Control Plane for durability.

**OutletProducerManager deduplication:**
- `outputStreamKey` = `EVENTHUB|{entityPath}|{sha256(connectionString).slice(0,16)}` or `PULSAR|{serviceUrl}|{topic}|{sha256(token).slice(0,16)}`
- Multiple outlets pointing to the same topic → share one producer connection
- Concurrent `getOrCreateProducer()` calls for the same key share a single creation promise
- Old expired producers closed in background with retry backoff (3 attempts, 100ms × 2^attempt)

---

## 7. DLQ Service (`dlq.service.ts` + `dlq.processor.ts`)

The DLQ processes messages that failed delivery. Runs as a separate process (`npm run start:dlq`).

**Polling intervals (from `config.ts` defaults — these are the actual values):**
| Interval | Default |
|----------|---------|
| Sticky message retry | **30 seconds** |
| Static message retry | **60 seconds** |
| Cleanup (delete processed > 7 days) | **3600 seconds** |

**DLQ processor behavior:**
- Sticky: fetches outlets with pending messages → retries in batches of 100
- Static: fetches pending static keys → fetches current mappings from Control Plane → updates outlet IDs → retries
- **Circuit breaker**: stops processing an outlet on the FIRST failure (does not skip and continue)
- Increments retry count on failure; tracks processing duration as histogram metric

**Cleanup**: deletes records with `status = 'processed'` older than 7 days, in batches.

---

## 8. Control Plane Client (`controlPlane.client.ts`)

Axios wrapper with:
- Auto-attach Bearer token via request interceptor (`authService.getAccessToken()`)
- 401 handling: clears token on auth errors ("Authentication required", "Invalid token", "Insufficient permissions")
- **No retry logic** — all errors propagate immediately

**API calls used:**
- `GET /app/{appName}` — fetch full app config on startup
- `POST /outlet/list` — bulk outlet fetch by IDs
- `POST /outlet/listByApp` — all outlets for an app
- `POST /staticMappings/getStaticMappings` — fetch key→outlet mappings
- `POST /stickyMappings/createAndGetStickyMappings` — create + fetch sticky assignments

Static mapping response: check for `.error` field (thrown). Sticky mapping response: data is nested under `.data` key.

---

## 9. What Good Code Looks Like

**Processor — extend base, implement only routing logic:**
```typescript
export class StaticRoutingProcessor extends BaseRoutingProcessor {
  async processBatch(messages: ReceivedEventData[]): Promise<void> {
    const byKey = this.groupMessagesByKey(messages);
    const missingKeys = /* keys not in cache */;
    const fetched = await controlPlaneClient.getStaticMappings(this.appName, missingKeys);
    staticMappingCache.update(this.appName, fetched);
    const mapping = staticMappingCache.getStaticMappings(this.appName, [...byKey.keys()]);
    const byOutlet = this.groupMessagesByOutlet(byKey, mapping);
    await Promise.all([...byOutlet.entries()].map(([outletId, msgs]) =>
      this.sendToOutlet(outletId, msgs)
    ));
  }
}
```

**Metrics — always wrap async operations:**
```typescript
await recordTiming('process_batch', async () => {
  await processor.processBatch(messages);
});
```

---

## 10. Anti-Patterns

| Anti-pattern | Why wrong |
|-------------|-----------|
| Creating `EqaProducer` directly | Bypasses OutletProducerManager deduplication — opens multiple connections to same topic |
| Calling `consumer.checkpoint()` before `processBatch()` | Messages could be lost if processor throws after checkpoint |
| Adding TTL to `StickyMappingCache` | Breaks the sticky guarantee — same key must always go to same outlet |
| Info-level log inside processing loop | Saturates logging pipeline at scale |
| Catching DLQ `sendToDLQ()` failures silently | DLQ failure must propagate — double failure needs visibility |
| Adding routing logic to `base.processor.ts` | Base is shared by all strategies — put strategy logic in the concrete class |

---

## 11. Performance Pipeline

Every PR triggers `.github/workflows/perf-benchmark.yml` automatically. Two parallel jobs (main + PR code) each spin up a full stack on isolated Pulsar topics, run 500K messages through both STICKY and STATIC routing, then a third job compares and posts results as a PR comment.

**What gets captured and compared:**

| Signal | How | Regression threshold |
|--------|-----|---------------------|
| Throughput (ops/sec) | `benchmark/compare-results.js` | warn ≥5% drop, fail ≥10% drop |
| CPU usage | Docker stats during run | warn ≥15% increase, fail ≥20% increase |
| Memory usage | Docker stats during run | warn ≥30% increase, fail ≥50% increase |
| CPU self-time by function | V8 `--cpu-prof` → `analyze-profiles.js` | informational only (no CI gate) |
| Heap allocation by function | V8 `--heap-prof` → `analyze-profiles.js` | informational only (no CI gate) |

**Profile diff in the PR comment:**
- Top 15 functions by CPU self-time: `main %` vs `PR %` vs `Δ` — bold if delta ≥ 3%
- Heap: top allocators by MB — main vs PR delta
- Raw `.cpuprofile` / `.heapprofile` artifacts are downloadable for SpeedScope or Chrome DevTools

**Noisy results:** CV > 15% on throughput → marked `NOISY`, not used for regression detection. Local Pulsar can be noisy; don't panic on NOISY results unless there's a clear directional signal.

**Hot paths to watch** — changes here will almost always show up in the CPU profile:
- `appInstance.ts` — `startProcessing()` loop body
- `base.processor.ts` — `groupMessagesByKey()`, `groupMessagesByOutlet()`, `sendToOutlet()`
- `static.processor.ts` / `sticky.processor.ts` — `processBatch()`
- `outletProducerManager.service.ts` — `getOrCreateProducer()`

**If the benchmark CI comment shows regression:**
1. Download the `.cpuprofile` from CI artifacts, open in SpeedScope (`speedscope.app`)
2. Look at the "Left Heavy" view — find functions that grew in the PR
3. Check for: new synchronous work in the loop, new object allocations per message, new awaits in the hot path
4. Fix or explicitly accept the regression with a comment in the PR

## For Review

### MUST FIX — blocks merge
- Producer created via `new EqaProducer(...)` outside `OutletProducerManager`
- Checkpoint called before `processBatch()` completes
- Info-level log in the `startProcessing()` loop body
- High-cardinality value (vId, outletId, appName per-message) as metric label
- `sendToDLQ()` failure silently swallowed

### SHOULD FIX
- New routing strategy not documented in `appInstance.ts` dispatch block
- DLQ retry logic without metric instrumentation on retry count
- Sticky mapping cache used without verifying key is app-scoped (`buildCacheKey()`)

### Testing Requirements
- Integration tests must use real PostgreSQL + EventHub/Pulsar emulator (from `docker-compose.infra.yaml`)
- Run `npm run test:setup-data` before integration tests
- Unit test all cache logic and processor grouping functions without I/O
