-- Cross-client PR-review metrics store. Run this once in the Supabase
-- SQL Editor (dashboard -> SQL Editor -> New query -> paste -> Run) before
-- deploying the ingest-metrics edge function.
--
-- Privacy note: this table only ever receives what metricsReporter.ts
-- sends — finding id/severity/title/verdict/mergeBlocking and aggregate
-- counts. It never receives file paths, root cause/impact/fix text,
-- validator reasoning, or source code. See src/output/metricsReporter.ts
-- in the Myco-backend repo for the enforced boundary on the sending side.

create table if not exists public.pr_review_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  repo text not null,
  pr_number integer,
  pr_url text not null,
  reported_at timestamptz not null,   -- timestamp the reviewer run itself reported
  received_at timestamptz not null default now(),  -- when this row landed
  findings jsonb not null,            -- MetricsFindingSummary[]
  summary jsonb not null              -- {total, confirmed, falsePositive, uncertain, bySeverity}
);

create index if not exists pr_review_metrics_client_id_idx on public.pr_review_metrics (client_id);
create index if not exists pr_review_metrics_received_at_idx on public.pr_review_metrics (received_at);

-- Row Level Security: locked down by default. Nothing reads or writes this
-- table except the edge function, which uses the service-role key and so
-- bypasses RLS entirely. This just makes sure no anon/publishable-key
-- client (e.g. a browser using the publishable key) can read or write it
-- directly.
alter table public.pr_review_metrics enable row level security;

-- Per-client rollup — confirmed/merge-blocking counts and a severity
-- breakdown, one row per client_id. Query with:
--   select * from public.pr_review_metrics_by_client;
create or replace view public.pr_review_metrics_by_client as
select
  client_id,
  count(*)                                                   as total_reviews,
  coalesce(sum((summary->>'total')::int), 0)                 as total_findings,
  coalesce(sum((summary->>'confirmed')::int), 0)             as total_confirmed,
  coalesce(sum((summary->>'falsePositive')::int), 0)         as total_false_positive,
  coalesce(sum((summary->>'uncertain')::int), 0)             as total_uncertain,
  coalesce(sum((select count(*) from jsonb_array_elements(findings) f
       where (f->>'mergeBlocking')::boolean and (f->>'verdict') = 'CONFIRMED'))
  , 0)                                                       as merge_blocking_confirmed,
  min(received_at)                                           as first_reported_at,
  max(received_at)                                           as last_reported_at
from public.pr_review_metrics
group by client_id;

-- Aggregate across every client — the single-row "overall" view.
--   select * from public.pr_review_metrics_overall;
create or replace view public.pr_review_metrics_overall as
select
  count(distinct client_id)                                  as clients,
  count(*)                                                    as review_runs,
  coalesce(sum((summary->>'total')::int), 0)                  as findings_total,
  coalesce(sum((summary->>'confirmed')::int), 0)              as findings_confirmed,
  coalesce(sum((summary->>'falsePositive')::int), 0)          as findings_false_positive,
  coalesce(sum((summary->>'uncertain')::int), 0)              as findings_uncertain
from public.pr_review_metrics;
