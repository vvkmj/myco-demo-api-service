# DRS Knowledge Doc

Root knowledge base for the Data Router System. Read this before touching any component.

> **Source of truth**: Code. This document is derived from code reading — if anything conflicts with CLAUDE.md or other docs, trust the code and update this file.

---

## 1. Purpose & Architecture

DRS routes messages from inlet event streams (EventHub or Pulsar) to one or more outlet streams based on configurable routing rules. Two routing strategies:

- **STATIC**: Explicit key → outlet mapping stored in control plane
- **STICKY**: Affinity-based — same key always routes to same outlet; assignments persisted in DB (not hash-based)

**Four components:**
- **Control Plane** (`apps/control-plane`): REST API for managing routing config (TSOA/Express)
- **Data Plane** (`apps/data-plane`): Message processing engine — polls Control Plane, routes messages
- **Database Migrations** (`apps/database-migrations`): Schema management, runs before everything else
- **Kube-strator** (`apps/kube-strator`): Optional — auto-deploys Data Plane instances per app in Kubernetes

**Shared packages:**
- `packages/connectors`: EQA wrappers for EventHub + Pulsar, Postgres access, Blob Storage
- `packages/drs-types`: Shared TypeScript types (discriminated unions for credential/config types)
- `packages/utilities`: Shared utility functions
- `packages/jest-config`, `packages/typescript-config`: Dev tooling (root-level, never per-component)

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 |
| Language | TypeScript (strict) |
| HTTP framework | Express + TSOA (Control Plane only) |
| Messaging | Azure EventHub SDK + Apache Pulsar via `@motorq/event-queue-abstraction` |
| Database | PostgreSQL via Knex.js |
| Auth | Azure AD (MSAL) + JWT |
| Secrets | Azure Key Vault |
| Checkpointing | Azure Blob Storage (EventHub) / native Pulsar ack |
| Build | Turborepo |
| Testing | Jest + Supertest (integration) |

---

## 3. Repo Structure

```
apps/
  control-plane/     # REST API for routing config management
  data-plane/        # Message routing engine
  database-migrations/
  kube-strator/
packages/
  connectors/        # EQA wrappers — the ONLY place connector type logic lives
  drs-types/         # Shared types — discriminated unions, no business logic
  utilities/
  jest-config/
  typescript-config/
composer/integration_test/  # docker-compose.infra.yaml — local dev infra
benchmark/          # Performance test scripts
docs/               # Architecture, FAQ, feature docs
patches/            # npm patch-package files
```

---

## 4. Universal Standards

### Single Responsibility
Every function, class, and file does one thing. Orchestrators coordinate — they don't contain logic. If you need to scroll more than one screen to read a function, it probably does too much.

### Error Propagation
Never swallow errors silently. Always log + rethrow or document why swallowing is intentional. Use `unknown` for caught errors. Preserve cause: `new Error('context', { cause: originalErr })`.

### No `console.log` / `console.error` in `src/`
Use `@motorq/logger`. This includes service and data-access layers. `console.*` is enforced by lint.

### Metrics — No High-Cardinality Labels
Never use device IDs, vehicle IDs (vId), user IDs, raw URLs, or request IDs as metric labels. Each unique value creates a new time series → OOM. Use `@motorq/metric-collector` for metrics, `@motorq/logger` for logs.

### No Info-Level Logs in Hot Paths
Message processing (Data Plane inner loop) uses `debug` level only. `info`-level logs in high-frequency paths saturate the logging pipeline.

### HTTP Mocking — Intercept at Network Layer
Node.js + Jest: use `nock` or `msw/node`. Both intercept at the http/https layer and verify real URL + method + headers. `jest.mock('axios')` only verifies a function was called — not what URL it called.

### SOLID / KISS / YAGNI
No speculative abstractions. No config flags for scenarios that don't exist. No premature generalization.

### Interface Versioning
Breaking changes to public API endpoints require a new version path (`/v2/...`). Never silently change the shape of an existing endpoint.

### Testing Matrix
- Pure functions → unit tests, no mocks
- I/O-touching code → unit tests with mocked I/O + integration tests for happy paths
- Integration tests: never mock the database — use real infrastructure via Docker Compose

---

## 5. DRS-Specific Conventions

### Strict File Naming (enforced by convention)
| Suffix | Purpose | Rules |
|--------|---------|-------|
| `*-controller.ts` | API endpoints (TSOA decorators) | Only calls service layer; no DB/HTTP |
| `*-service.ts` | Business logic + orchestration | Calls data-access, validators, clients; no direct DB/HTTP |
| `*-data-access.ts` | Database operations only | SELECT/INSERT/UPDATE/DELETE; no business logic |
| `*-client.ts` | External HTTP calls only | No DB, no business logic |
| `*-validator.ts` | Synchronous validation only | Pure functions; no async, no DB, no HTTP |

### Primary Keys
UUID v7 for all new records. Never use auto-increment integers.

### Pagination
Cursor-based (by `app_name` or UUID). Never offset-based. Fetch `limit+1` to detect next page.

### Timestamps
All timestamps UTC via `knex.fn.now()`. No explicit timezone handling needed.

---

## 6. Backend Service Standards

### API Design
- All HTTP endpoints must have OpenAPI documentation (TSOA decorators in Control Plane)
- Breaking API changes require a new version path (`/v2/...`)
- Request validation at the boundary (validator layer) — never trust raw input

### Database
- Migrations must be backward-compatible: never drop a column or rename in a single step
- No raw SQL strings with interpolated variables — use Knex parameterized queries
- Never run migrations at service startup in production — migrations are a separate pipeline step

### Configuration
- `process.env` read once at startup via `config.ts` — never read inside request handlers or hot paths
- All required env vars validated at startup — fail fast with a clear error if missing

### Auth
- Auth middleware must not be bypassed in tests. Use test JWTs, not `req.user = { id: 'test' }`

### Graceful Shutdown
- Handle SIGTERM: drain in-flight operations, close connections, then exit
- Data Plane: 2-second grace period for processing loop to exit before closing consumer

---

## 7. Known Risks (Cross-Component)

### Connector Update Race Condition (TOFIX.md — Medium Risk)
`PUT /connector/{id}` validates against live EventHub concurrently. Concurrent updates can cause inconsistent state. Mitigation: use optimistic locking or queue updates before merging new connector update logic.

### KeyVault Writes Outside Transactions (Control Plane)
KeyVault credential storage happens outside DB transactions. If the DB transaction fails after KeyVault write, the secret is orphaned. Any code touching credential storage must account for this. Document intentionally if accepting the risk.

---

## For Review

### MUST FIX — blocks merge
- `console.log` / `console.error` in `src/` — use `@motorq/logger`
- Info-level log in message processing hot path — use debug
- High-cardinality value as metric label (vId, device ID, URL)
- Breaking API shape without version bump
- HTTP mocking via `jest.mock('axios')` — use nock/msw instead
- Producer created outside `OutletProducerManager` (Data Plane)
- `EqaConsumer` / `EqaProducer` instantiated directly instead of via `ConnectorFactory`
- New connector type not added to `deriveOutputStreamKey()` in ConnectorFactory
- New routing strategy not registered in `appInstance.ts` type dispatch

### SHOULD FIX
- Pure logic mixed with I/O without documented reason
- Error wrapped but `cause` not preserved
- New pure function without unit test
- New external dependency without integration test
- KeyVault failure silently falling back without metric or structured log

### Flywheel Check (after every PR)
1. Did this review catch something not in KNOWLEDGE.md? → Update it now
2. Did a MUST FIX fire that was fine? → Remove or downgrade the rule
3. Did anything prove wrong? → Correct it
