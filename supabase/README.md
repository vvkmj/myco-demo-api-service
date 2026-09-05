# Cross-client metrics backend (Supabase)

Backend for `METRICS_ENDPOINT`/`METRICS_API_KEY` (see `src/output/metricsReporter.ts`
in the Zenith repo). Receives a privacy-minimized summary (counts + finding
id/severity/title/verdict/mergeBlocking — never file paths, root cause, fix
text, or code) after each reviewer run and stores it for per-client and
aggregate-across-clients rollups.

Project: `https://liuxmyrceaurpsjiatfk.supabase.co`

## Why an edge function instead of pointing straight at Supabase's REST API

Supabase auto-generates a REST endpoint per table, but it requires an
`apikey` header (not just `Authorization: Bearer`) and would mean handing
every pilot client's CI a Supabase key. Instead, `ingest-metrics` is a small
edge function that accepts one generic bearer token (unrelated to any
Supabase key) and does the actual insert itself using the service-role key
(which Supabase injects into every edge function automatically — it's never
exposed to callers). This keeps `METRICS_ENDPOINT`/`METRICS_API_KEY` fully
backend-agnostic on every client's side, exactly like the code comments in
`metricsReporter.ts` already called out as the intended design.

## 1. Create the table

Supabase dashboard → SQL Editor → New query → paste the contents of
`schema.sql` → Run. Creates `pr_review_metrics` (RLS-locked — only the edge
function's service-role key can read/write it) plus two convenience views:
`pr_review_metrics_by_client` (per-client rollup) and
`pr_review_metrics_overall` (aggregate across every client).

## 2. Deploy the edge function

**No CLI needed** — dashboard → Edge Functions → Create a new function →
name it `ingest-metrics` → paste the entire contents of `index.dashboard.ts`
→ Deploy.

(If you'd rather use the Supabase CLI for versioned deploys: `handler.ts` +
`index.ts` in this folder are the actual source — `index.dashboard.ts` is a
generated single-file concatenation of the two, for the no-CLI path only.
CLI path: `supabase functions deploy ingest-metrics` from a project with
these two files under `supabase/functions/ingest-metrics/`.)

## 3. Set the function's secret

The function checks incoming requests against a secret you choose —
`METRICS_INGEST_KEY` — completely separate from any Supabase key. Dashboard
→ Edge Functions → `ingest-metrics` → Secrets (or Settings) → add
`METRICS_INGEST_KEY`.

A generated value if you want one (treat it like any other API key — this
one, or one you generate yourself, either is fine, just don't reuse it
anywhere else):

```
Blt5y2XJ_MnQVZXINkzuK-CnP6kyjmA8-dyZe0TJE4c
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` don't need to be set manually
— Supabase injects both into every edge function's environment
automatically.

## 4. Get the function's URL

Dashboard → Edge Functions → `ingest-metrics` shows the deployed URL —
typically:

```
https://liuxmyrceaurpsjiatfk.supabase.co/functions/v1/ingest-metrics
```

## 5. Wire it into a client's workflow

In that client's GitHub Actions secrets:

```
METRICS_ENDPOINT = https://liuxmyrceaurpsjiatfk.supabase.co/functions/v1/ingest-metrics
METRICS_API_KEY  = <the METRICS_INGEST_KEY value from step 3>
```

And pass them through in the workflow (already wired in
`myco-bundled-action`'s `action.yml` as `metrics_endpoint`/`metrics_api_key`
inputs):

```yaml
      - uses: AbhishikaAgarwal/myco-bundled-action@v1
        with:
          # ...
          metrics_endpoint: ${{ secrets.METRICS_ENDPOINT }}
          metrics_api_key: ${{ secrets.METRICS_API_KEY }}
```

Reporting is entirely opt-in and non-fatal — a client that never sets
`metrics_endpoint` sees zero behavior change, and a slow/unreachable/
misconfigured endpoint only logs a warning, never fails the actual PR
review or CI gate.

## Querying the data

SQL Editor:

```sql
select * from public.pr_review_metrics_by_client order by review_runs desc;
select * from public.pr_review_metrics_overall;
```

Or the individual rows for one client:

```sql
select * from public.pr_review_metrics
where client_id = 'uniformbasket/backend'
order by received_at desc;
```

## Testing before deploying

`handler.ts` (auth check, payload validation, DB row shaping) has zero
Deno-specific imports on purpose, so it's unit tested with plain Node —
see `test-ingestMetricsHandler.ts` at the Zenith repo root (26/26 checks:
auth rejection/acceptance, every payload-validation edge case, and correct
row mapping). `index.ts`/`index.dashboard.ts` are a thin wrapper around it —
the only untested part is Deno-specific plumbing (reading the request,
calling `supabase.from(...).insert(...)`, shaping the HTTP response), which
there was no Deno runtime available to exercise directly. Worth a quick
manual smoke test once deployed:

```bash
curl -i -X POST 'https://liuxmyrceaurpsjiatfk.supabase.co/functions/v1/ingest-metrics' \
  -H 'Authorization: Bearer <METRICS_INGEST_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "test/smoke",
    "repo": "test/smoke",
    "pr_url": "https://github.com/test/smoke/pull/1",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "findings": [{"id":"P1-1","severity":"P1","title":"test finding","verdict":"CONFIRMED","mergeBlocking":true}],
    "summary": {"total":1,"confirmed":1,"falsePositive":0,"uncertain":0,"bySeverity":{"P1":1}}
  }'
```

Expect `{"ok":true}` with HTTP 200, then a matching row in
`select * from public.pr_review_metrics where client_id = 'test/smoke';`.
