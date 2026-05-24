import * as fs from "fs";
import * as path from "path";
import { FindingCard } from "../review/finding";
import { ValidatedFinding } from "../validate/findingValidator";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FindingsJson {
  prUrl: string;
  reviewedAt: string;
  summary: { risk: string; recommendation: string };
  /** All parsed findings (unvalidated when validation is disabled). */
  findings: (FindingCard | ValidatedFinding)[];
  /** Only set when validation ran. */
  confirmedBlockers: ValidatedFinding[];
  hasConfirmedBlockers: boolean;
  validated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary extractor
// ─────────────────────────────────────────────────────────────────────────────

function extractSummary(reviewMarkdown: string): { risk: string; recommendation: string } {
  const riskMatch = reviewMarkdown.match(/\*\*Risk Level:\*\*\s*([^\n]+)/i) ||
    reviewMarkdown.match(/Risk Level[:\s]+([^\n]+)/i);
  const recMatch = reviewMarkdown.match(/\*\*Recommendation:\*\*\s*([^\n]+)/i) ||
    reviewMarkdown.match(/Recommendation[:\s]+([^\n]+)/i);

  return {
    risk: riskMatch ? riskMatch[1].trim() : "Unknown",
    recommendation: recMatch ? recMatch[1].trim() : "Unknown",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write findings.json to the output directory.
 * Returns the absolute path of the written file.
 */
export function writeFindingsJson(
  outputDir: string,
  prUrl: string,
  reviewMarkdown: string,
  findings: (FindingCard | ValidatedFinding)[],
  validated: boolean
): string {
  const confirmedBlockers = validated
    ? (findings as ValidatedFinding[]).filter(
        (f) => "verdict" in f && f.verdict === "CONFIRMED" && f.mergeBlocking
      )
    : [];

  const data: FindingsJson = {
    prUrl,
    reviewedAt: new Date().toISOString(),
    summary: extractSummary(reviewMarkdown),
    findings,
    confirmedBlockers,
    hasConfirmedBlockers: confirmedBlockers.length > 0,
    validated,
  };

  const outputPath = path.join(outputDir, "findings.json");
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket hash deduplication store
// ─────────────────────────────────────────────────────────────────────────────

const HASH_FILE = "ticket-hashes.json";

export function loadTicketHashes(outputDir: string): Record<string, string> {
  const p = path.join(outputDir, HASH_FILE);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

export function saveTicketHash(outputDir: string, hash: string, ticketUrl: string): void {
  const hashes = loadTicketHashes(outputDir);
  hashes[hash] = ticketUrl;
  fs.writeFileSync(path.join(outputDir, HASH_FILE), JSON.stringify(hashes, null, 2), "utf-8");
}
