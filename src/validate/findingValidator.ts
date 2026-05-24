import * as crypto from "crypto";
import { LLMClient } from "../llm/claudeClient";
import { FindingCard } from "../review/finding";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = "CONFIRMED" | "FALSE_POSITIVE" | "UNCERTAIN";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface ValidatedFinding extends FindingCard {
  verdict: Verdict;
  mergeBlocking: boolean;
  confidence: Confidence;
  validatorReasoning: string;
  /** Stable 8-char hash for deduplication — based on filePath + severity + rootCause. */
  hash: string;
  /** Set after ticket creation. */
  ticketUrl?: string;
  /** Set to "flagged_for_human_review" for UNCERTAIN findings. */
  status?: "flagged_for_human_review";
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash
// ─────────────────────────────────────────────────────────────────────────────

export function findingHash(finding: FindingCard): string {
  const key = `${finding.filePath}|${finding.severity}|${finding.rootCause.slice(0, 100)}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────

function buildValidatorPrompt(
  findings: FindingCard[],
  diffMarkdown: string,
  codeContext: string | undefined
): string {
  const findingCards = findings
    .map(
      (f) =>
        `---\n**[${f.id}]** ${f.title}\n**File:** ${f.file}\n**Root cause:** ${f.rootCause}\n**Impact:** ${f.impact}\n**Fix:** ${f.fix}\n---`
    )
    .join("\n\n");

  const hasCodeContext = !!codeContext && codeContext.trim().length > 0;

  return `You are a senior engineer validating bug findings flagged by an automated SDET review agent.

Your job is to determine — for each finding below — whether it is a real bug, a false positive, or uncertain, based on the actual codebase. Use the \`read_file\` tool to read specific files you need to verify a claim — use the exact file path from the finding card or the diff. Only read files directly relevant to the finding being validated; do not read files speculatively.

---

## Instructions

1. For every finding card below, produce a verdict block in the exact format specified.
2. Read the relevant source files to ground your verdict. Do not speculate — if you cannot verify a claim without reading the file, use the read_file tool.
3. CONFIRMED = the bug is real and present in the code as described.
4. FALSE_POSITIVE = the code already handles the case, or the claim is incorrect.
5. UNCERTAIN = you cannot definitively confirm or deny without runtime information.
6. Merge-blocking = this bug, if real, would cause a crash, data loss, security issue, or broken contract in production.
7. Be concise in Reasoning — one to three sentences max. Name the specific line or function that proves your verdict.

---

## Output Format

Produce one verdict block per finding, in this exact format:

\`\`\`
[BLOCKER-1]
Verdict: CONFIRMED
Merge-blocking: yes
Confidence: HIGH
Reasoning: <one to three sentences, cite specific file/line>
\`\`\`

Use exactly these field names. The ID line must be plain text — do NOT wrap it in bold (**) or any other formatting. Verdict must be CONFIRMED / FALSE_POSITIVE / UNCERTAIN. Merge-blocking must be yes / no. Confidence must be HIGH / MEDIUM / LOW.

Do not produce any other output — only the verdict blocks, one per finding, in the same order as the findings below.

---

## Findings to Validate

${findingCards}

---

## Original Diff

${diffMarkdown}

${hasCodeContext ? `---\n\n## Related Code Context (import graph)\n${codeContext}\n` : ""}

---

Produce the verdict blocks now.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict parser
// ─────────────────────────────────────────────────────────────────────────────

function parseVerdicts(
  raw: string,
  findings: FindingCard[]
): Map<string, { verdict: Verdict; mergeBlocking: boolean; confidence: Confidence; reasoning: string }> {
  const results = new Map<
    string,
    { verdict: Verdict; mergeBlocking: boolean; confidence: Confidence; reasoning: string }
  >();

  // Each block starts with [SEVERITY-N] on its own line.
  // The LLM may mirror the bold-bracket format from the input cards (**[P1-3]**),
  // so we tolerate optional ** wrapping around the ID in both the start pattern
  // and the lookahead terminator.
  const blockPattern =
    /\*{0,2}\[(BLOCKER|P1|P2|P3)-(\d+)\]\*{0,2}\s*\nVerdict:\s*(CONFIRMED|FALSE_POSITIVE|UNCERTAIN)\s*\nMerge-blocking:\s*(yes|no)\s*\nConfidence:\s*(HIGH|MEDIUM|LOW)\s*\nReasoning:\s*([\s\S]+?)(?=\n\*{0,2}\[(?:BLOCKER|P1|P2|P3)-\d+\]\*{0,2}|\n```|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(raw)) !== null) {
    const [, severity, num, verdict, blocking, confidence, reasoning] = match;
    const id = `${severity.toUpperCase()}-${num}`;
    results.set(id, {
      verdict: verdict.toUpperCase() as Verdict,
      mergeBlocking: blocking.toLowerCase() === "yes",
      confidence: confidence.toUpperCase() as Confidence,
      reasoning: reasoning.trim(),
    });
  }

  // For any finding whose id wasn't parsed, default to UNCERTAIN.
  // Warn loudly — a missing verdict almost always means an LLM output format
  // deviation that the regex didn't catch, not a genuine UNCERTAIN decision.
  for (const f of findings) {
    if (!results.has(f.id)) {
      console.warn(
        `  ⚠️   [${f.id}] No verdict parsed from validator output — defaulting to UNCERTAIN. ` +
        `Check LLM output format (did the model wrap the ID in bold like **[${f.id}]**?).`
      );
      results.set(f.id, {
        verdict: "UNCERTAIN",
        mergeBlocking: f.severity === "BLOCKER" || f.severity === "P1",
        confidence: "LOW",
        reasoning: "Validator did not produce a verdict for this finding.",
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a second-pass LLM validation on all findings from the initial review.
 * Uses a single batch call so the model can reason across all findings at once.
 */
export async function validateFindings(
  findings: FindingCard[],
  diffMarkdown: string,
  repoPath: string | undefined,
  codeContext: string | undefined,
  claude: LLMClient
): Promise<ValidatedFinding[]> {
  if (findings.length === 0) return [];

  console.log(
    `\n🔍  Validating ${findings.length} finding(s) against the codebase...`
  );

  const prompt = buildValidatorPrompt(findings, diffMarkdown, codeContext);

  // Use a separate validator model if configured, otherwise fall back to the
  // same model. We pass repoPath so the validator can use read_file tool calls.
  const savedModel = process.env.LITELLM_MODEL;
  if (process.env.VALIDATOR_MODEL) {
    process.env.LITELLM_MODEL = process.env.VALIDATOR_MODEL;
  }

  let rawResponse: string;
  try {
    rawResponse = await claude.generate(prompt, repoPath);
  } finally {
    // Restore original model regardless of outcome
    if (process.env.VALIDATOR_MODEL && savedModel !== undefined) {
      process.env.LITELLM_MODEL = savedModel;
    } else if (process.env.VALIDATOR_MODEL) {
      delete process.env.LITELLM_MODEL;
    }
  }

  const verdicts = parseVerdicts(rawResponse, findings);

  const validated: ValidatedFinding[] = findings.map((f) => {
    const v = verdicts.get(f.id)!;
    return {
      ...f,
      verdict: v.verdict,
      mergeBlocking: v.mergeBlocking,
      confidence: v.confidence,
      validatorReasoning: v.reasoning,
      hash: findingHash(f),
      ...(v.verdict === "UNCERTAIN" ? { status: "flagged_for_human_review" as const } : {}),
    };
  });

  const confirmed = validated.filter((v) => v.verdict === "CONFIRMED").length;
  const fp = validated.filter((v) => v.verdict === "FALSE_POSITIVE").length;
  const uncertain = validated.filter((v) => v.verdict === "UNCERTAIN").length;
  const blocking = validated.filter((v) => v.mergeBlocking && v.verdict === "CONFIRMED").length;

  console.log(
    `✅  Validation complete — ` +
    `Confirmed: ${confirmed}, False positives: ${fp}, Uncertain: ${uncertain}` +
    (blocking > 0 ? `, Merge blockers: ${blocking}` : "")
  );

  return validated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown section builder (appended to the review file)
// ─────────────────────────────────────────────────────────────────────────────

export function buildValidationSection(validated: ValidatedFinding[]): string {
  if (validated.length === 0) return "";

  const verdictEmoji: Record<Verdict, string> = {
    CONFIRMED: "CONFIRMED",
    FALSE_POSITIVE: "FALSE POSITIVE",
    UNCERTAIN: "UNCERTAIN",
  };

  const rows = validated
    .map((v) => {
      const ticket = v.ticketUrl ? `[ticket](${v.ticketUrl})` : "—";
      return `| ${v.id} | ${verdictEmoji[v.verdict]} | ${v.mergeBlocking ? "Yes" : "No"} | ${v.confidence} | ${ticket} |`;
    })
    .join("\n");

  const detailBlocks = validated
    .map(
      (v) =>
        `**[${v.id}]** ${v.title}\n` +
        `Verdict: ${v.verdict} · Merge-blocking: ${v.mergeBlocking ? "Yes" : "No"} · Confidence: ${v.confidence}\n` +
        `Reasoning: ${v.validatorReasoning}` +
        (v.ticketUrl ? `\nTicket: ${v.ticketUrl}` : "")
    )
    .join("\n\n---\n\n");

  return `\n\n---\n\n### Section 5 — Validation Results\n\n` +
    `| Finding | Verdict | Merge-blocking | Confidence | Ticket |\n` +
    `|---------|---------|----------------|------------|--------|\n` +
    `${rows}\n\n` +
    `#### Details\n\n${detailBlocks}\n`;
}
