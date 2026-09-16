import axios from "axios";
import { ValidatedFinding } from "../validate/findingValidator";
import { DiffContext } from "../github/prFetcher";
import { FindingCard } from "../review/finding";

// ─────────────────────────────────────────────────────────────────────────────
// Cross-client metrics reporting.
//
// Required: every completed review must be represented in Myco's dashboard.
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

type ReportableFinding = Pick<FindingCard, "id" | "severity" | "title"> &
  Partial<Pick<ValidatedFinding, "verdict" | "mergeBlocking">>;

export function buildMetricsPayload(
  diff: Pick<DiffContext, "owner" | "repo" | "prNumber">,
  prUrl: string,
  findings: ReportableFinding[]
): MetricsPayload {
  const bySeverity: Record<string, number> = {};
  let confirmed = 0;
  let falsePositive = 0;
  let uncertain = 0;

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    if (f.verdict === "CONFIRMED") confirmed++;
    else if (f.verdict === "FALSE_POSITIVE") falsePositive++;
    else if (f.verdict === "UNCERTAIN") uncertain++;
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
      verdict: f.verdict || "UNVALIDATED",
      mergeBlocking: f.mergeBlocking || false,
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
 * Metrics are part of the Myco product contract. A failed write fails the job
 * so a missing dashboard record is visible and can be retried from Actions.
 */
export async function reportMetrics(
  diff: Pick<DiffContext, "owner" | "repo" | "prNumber">,
  prUrl: string,
  findings: ReportableFinding[]
): Promise<void> {
  const endpoint = process.env.METRICS_ENDPOINT!;

  const payload = buildMetricsPayload(diff, prUrl, findings);
  const apiKey = process.env.METRICS_API_KEY;
  console.log(
    `  ℹ️   Reporting metrics to ${endpoint} for ${payload.client_id}.`
  );

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
    // Surface the actual HTTP status + response body when we have one (e.g.
    // Supabase's gateway-level "Missing authorization header" from JWT
    // enforcement being re-enabled reads very differently from the ingest
    // function's own "invalid token" — both otherwise collapse into the
    // same generic axios "Request failed with status code 401" message).
    const status = err?.response?.status;
    const body = err?.response?.data;
    const detail = status
      ? ` [HTTP ${status}]${body ? ` ${typeof body === "string" ? body : JSON.stringify(body)}` : ""}`
      : "";
    throw new Error(`Metrics reporting failed: ${err.message}${detail}`);
  }
}
