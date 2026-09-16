// Pure, framework-agnostic logic for the ingest-metrics edge function —
// deliberately has zero Deno-specific imports so it can be unit-tested with
// plain Node/ts-node. index.ts (the actual Deno entrypoint deployed to
// Supabase) is a thin wrapper around this file: it only does auth-header
// extraction, JSON parsing, the DB insert call, and HTTP response shaping —
// everything decision-worthy lives here where it's testable.

export interface MetricsFindingSummary {
  id: string;
  severity: string;
  title: string;
  verdict: string;
  mergeBlocking: boolean;
}

export interface MetricsPayload {
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

export interface MetricsRow {
  client_id: string;
  repo: string;
  pr_number: number | null;
  pr_url: string;
  reported_at: string;
  findings: MetricsFindingSummary[];
  summary: MetricsPayload["summary"];
}

/**
 * Constant-time-ish comparison isn't critical here (this isn't a
 * cryptographic signature, just a shared-secret bearer token check), but we
 * still avoid the most naive short-circuiting `===` timing difference isn't
 * a real concern at this payload size — kept as plain equality deliberately
 * for readability. Real security boundary is: this key is never sent to
 * clients, only configured once as a GitHub Actions secret + a Supabase
 * function secret.
 */
export function validateAuth(authHeader: string | null | undefined, expectedKey: string): boolean {
  if (!expectedKey) return false; // misconfigured function — never silently accept
  if (!authHeader) return false;
  const match = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  if (!match) return false;
  return match[1] === expectedKey;
}

export type ValidationResult =
  | { valid: true; payload: MetricsPayload }
  | { valid: false; error: string };

const ALLOWED_VERDICTS = new Set(["CONFIRMED", "FALSE_POSITIVE", "UNCERTAIN", "UNVALIDATED"]);

/**
 * Validates the inbound payload shape. Deliberately strict about the
 * required top-level fields (so a malformed client doesn't silently insert
 * garbage rows), but permissive about `findings` contents beyond basic
 * typing — this is a metrics sink, not the source of truth.
 */
export function validatePayload(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { valid: false, error: "Request body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.client_id !== "string" || !b.client_id) {
    return { valid: false, error: "Missing/invalid required field: client_id" };
  }
  if (typeof b.repo !== "string" || !b.repo) {
    return { valid: false, error: "Missing/invalid required field: repo" };
  }
  if (typeof b.pr_url !== "string" || !b.pr_url) {
    return { valid: false, error: "Missing/invalid required field: pr_url" };
  }
  if (typeof b.timestamp !== "string" || Number.isNaN(Date.parse(b.timestamp))) {
    return { valid: false, error: "Missing/invalid required field: timestamp (expected an ISO date string)" };
  }
  if (b.pr_number !== undefined && typeof b.pr_number !== "number") {
    return { valid: false, error: "Invalid field: pr_number must be a number if present" };
  }
  if (!Array.isArray(b.findings)) {
    return { valid: false, error: "Missing/invalid required field: findings (expected an array)" };
  }
  for (const f of b.findings) {
    if (
      typeof f !== "object" || f === null ||
      typeof (f as any).id !== "string" ||
      typeof (f as any).severity !== "string" ||
      typeof (f as any).title !== "string" ||
      typeof (f as any).verdict !== "string" || !ALLOWED_VERDICTS.has((f as any).verdict) ||
      typeof (f as any).mergeBlocking !== "boolean"
    ) {
      return { valid: false, error: "Invalid entry in findings — expected {id, severity, title, verdict, mergeBlocking}" };
    }
  }
  const s = b.summary;
  if (
    typeof s !== "object" || s === null ||
    typeof (s as any).total !== "number" ||
    typeof (s as any).confirmed !== "number" ||
    typeof (s as any).falsePositive !== "number" ||
    typeof (s as any).uncertain !== "number" ||
    typeof (s as any).bySeverity !== "object" || (s as any).bySeverity === null
  ) {
    return { valid: false, error: "Missing/invalid required field: summary" };
  }

  return { valid: true, payload: b as unknown as MetricsPayload };
}

export function toRow(payload: MetricsPayload): MetricsRow {
  return {
    client_id: payload.client_id,
    repo: payload.repo,
    pr_number: payload.pr_number ?? null,
    pr_url: payload.pr_url,
    reported_at: payload.timestamp,
    findings: payload.findings,
    summary: payload.summary,
  };
}
