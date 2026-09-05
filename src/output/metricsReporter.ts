import axios from "axios";
import { ValidatedFinding } from "../validate/findingValidator";
import { DiffContext } from "../github/prFetcher";

// ─────────────────────────────────────────────────────────────────────────────
// Cross-client metrics reporting.
//
// Opt-in: if METRICS_ENDPOINT isn't set, this is a complete no-op — existing
// clients (or a pilot that never configures it) see zero behavior change.
//
// Deliberately minimal payload — "counts + finding summaries", not full
// findings detail. What's sent: finding id, severity, title, verdict,
// mergeBlocking. What's NEVER sent: file paths, root cause, impact, fix
// text, validator reasoning, or any source code. A finding's title can
// hint at the shape of a bug ("Unhandled null in getConfig()") without
// revealing the client's actual file layout or business logic. This is a
// deliberate privacy line — widen it only with an explicit decision, not by
// convenience later.
//
// Backend-agnostic on purpose: this just POSTs JSON to a configurable
// endpoint with a bearer token. Whatever receives it (a serverless
// function, a Supabase edge function, anything) can be swapped without
// touching any client's repo or workflow.
// ─────────────────────────────────────────────────────────────────────────────

export interface MetricsFindingSummary {
  id: string;
  severity: string;
  title: string;
  verdict: string;
  mergeBlocking: boolean;
}

export interface MetricsPayload {
  /** Identifies the pilot client for per-client + aggregate rollups. Defaults
   *  to "owner/repo" if CLIENT_ID isn't explicitly set — set CLIENT_ID when
   *  a client's actual org/repo name shouldn't double as their identifier. */
  client_id: string;
  repo: string;
  pr_number?: number;
  pr_url: string;
  timestamp: string;
  findings: MetricsFindingSummary[];
  summary: {
    total: number;
    confirmed: number;
    falsePositive: number;
    uncertain: number;
    bySeverity: Record<string, number>;
  };
}

export function buildMetricsPayload(
  diff: Pick<DiffContext, "owner" | "repo" | "prNumber">,
  prUrl: string,
  findings: ValidatedFinding[]
): MetricsPayload {
  const bySeverity: Record<string, number> = {};
  let confirmed = 0;
  let falsePositive = 0;
  let uncertain = 0;

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    if (f.verdict === "CONFIRMED") confirmed++;
    else if (f.verdict === "FALSE_POSITIVE") falsePositive++;
    else uncertain++;
  }

  return {
    client_id: process.env.CLIENT_ID || `${diff.owner}/${diff.repo}`,
    repo: `${diff.owner}/${diff.repo}`,
    pr_number: diff.prNumber,
    pr_url: prUrl,
    timestamp: new Date().toISOString(),
    findings: findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      title: f.title,
      verdict: f.verdict,
      mergeBlocking: f.mergeBlocking,
    })),
    summary: {
      total: findings.length,
      confirmed,
      falsePositive,
      uncertain,
      bySeverity,
    },
  };
}

/**
 * Best-effort metrics report. Never throws — a slow, unreachable, or
 * misconfigured metrics endpoint must never fail the actual PR review or
 * the CI gate. A short timeout keeps a hung endpoint from delaying the run.
 */
export async function reportMetrics(
  diff: Pick<DiffContext, "owner" | "repo" | "prNumber">,
  prUrl: string,
  findings: ValidatedFinding[]
): Promise<void> {
  const endpoint = process.env.METRICS_ENDPOINT;
  if (!endpoint) return;

  const payload = buildMetricsPayload(diff, prUrl, findings);
  const apiKey = process.env.METRICS_API_KEY;

  try {
    await axios.post(endpoint, payload, {
      timeout: 5000,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    console.log(
      `  📊  Metrics reported (${payload.summary.total} finding(s), ${payload.summary.confirmed} confirmed) for ${payload.client_id}.`
    );
  } catch (err: any) {
    console.warn(`  ⚠️   Metrics reporting failed (non-fatal): ${err.message}`);
  }
}
