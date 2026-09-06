import * as fs from "fs";
import * as path from "path";
import { LLMClient } from "../llm/claudeClient";
import { DiffContext } from "../github/prFetcher";

export type Severity = "BLOCKER" | "P1" | "P2" | "P3";

export interface ReviewInput {
  diff: DiffContext;
  diffMarkdown: string;
  /** Absolute path to the locally checked-out repo. Model will read files on demand. */
  repoPath?: string;
  codeContext?: string;
  testCoverageSummary: string;
  outputDir: string;
  /** Minimum severity to include in the review. Findings below this are dropped. */
  minSeverity?: Severity;
  /** Best-effort text fetched from links found in the PR description (see src/intent/linkFetcher.ts). Undefined/empty if none found or link-following is disabled. */
  linkedContext?: string;
}

export interface ReviewOutput {
  reviewMarkdown: string;
  outputPath: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export async function reviewPR(
  input: ReviewInput,
  claude: LLMClient
): Promise<ReviewOutput> {
  const { diff, diffMarkdown, repoPath, codeContext, testCoverageSummary, outputDir, minSeverity, linkedContext } = input;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${diff.slug}_review.md`;
  const outputPath = path.join(outputDir, filename);

  // Open a write stream so the review is written progressively as chunks arrive.
  // Terminal output is suppressed inside generate() when a stream is passed.
  const fileStream = fs.createWriteStream(outputPath, { encoding: "utf-8" });
  console.log(`\n🔬 Running SDET review... (streaming → ${outputPath})`);

  const prompt = buildReviewPrompt(diff, diffMarkdown, codeContext, testCoverageSummary, minSeverity, linkedContext);
  const review = await claude.generate(prompt, repoPath, fileStream);

  if (!review || review.trim().length === 0) {
    throw new Error("Claude returned an empty review");
  }

  console.log(`✅ Review written to ${outputPath}`);
  return { reviewMarkdown: review.trim(), outputPath };
}

function severityThresholdNote(minSeverity: Severity | undefined): string {
  if (!minSeverity || minSeverity === "BLOCKER") return "";
  const rank = SEVERITY_RANK[minSeverity];
  const excluded = (["BLOCKER", "P1", "P2", "P3"] as Severity[])
    .filter((s) => SEVERITY_RANK[s] > rank)
    .join(", ");
  return excluded
    ? `\n> **Scope:** Report only ${minSeverity} and above. Omit ${excluded} findings entirely.\n`
    : "";
}

function buildIntentSection(diff: DiffContext, linkedContext: string | undefined): string {
  const description = diff.description?.trim();
  if (!description && !linkedContext) {
    return `## Stated Intent\n\n_No PR description was provided, and no links were found to follow. Intent is unknown — do not guess or invent one. Skip the intent-alignment check in step 5 below and note in the Executive Summary that intent could not be assessed._`;
  }

  const parts = [`## Stated Intent`, ``, `### PR description (as written by the author)`, description || "_Empty._"];

  if (linkedContext) {
    parts.push(
      ``,
      `### Linked context (fetched from link(s) in the description above)`,
      `Best-effort only — some links may show as unavailable below (auth-gated or JS-rendered pages can't be read this way). Treat unavailable links as referenced-but-unread, not as evidence of anything.`,
      ``,
      linkedContext
    );
  }

  return parts.join("\n");
}

function buildReviewPrompt(
  diff: DiffContext,
  diffMarkdown: string,
  codeContext: string | undefined,
  testCoverageSummary: string,
  minSeverity?: Severity,
  linkedContext?: string
): string {
  const hasTests = testCoverageSummary.trim().length > 0;
  const hasCodeContext = !!codeContext && codeContext.trim().length > 0;
  const thresholdNote = severityThresholdNote(minSeverity);
  const hasIntent = !!diff.description?.trim() || !!linkedContext;

  const header =
    diff.sourceType === "pr"
      ? `**PR #${diff.prNumber} — "${diff.title}"**\nRepo: ${diff.owner}/${diff.repo} · Branch: \`${diff.headRef}\` → \`${diff.baseRef}\``
      : `**Tag diff — "${diff.title}"**\nRepo: ${diff.owner}/${diff.repo} · \`${diff.baseRef}\` → \`${diff.headRef}\` (${diff.commits.length} commits)`;

  const inputLabel = diff.sourceType === "pr" ? "PR" : "release";
  const intentSection = buildIntentSection(diff, linkedContext);

  return `You are a senior SDET reviewing a production ${inputLabel}. Be precise and concise — no filler prose.
${thresholdNote}
${header}

---

${intentSection}

---

## Instructions

1. Start with the Stated Intent section above. Before looking at any code, form a one-sentence understanding of what this change is supposed to accomplish — from the PR description and, if present, the fetched linked context. If intent is unknown (empty description, no usable links), say so explicitly later rather than guessing.
2. Read the diff below. Each diff line is prefixed with its absolute file line number: \`+44: added code\`, \` 44: context\`, \`-43: removed code\`. Use these numbers directly when filling in the **File:** field — do not recount from @@ headers. The code context section already includes the changed files and their direct import dependencies. Use the \`read_file\` tool only for files you cannot see yet but have specific reason to check — for example: a caller of a changed function (look for the import path in the code context or diff), a file that re-exports a changed symbol, or a sibling module in the same package. Read files by their exact path; do not guess speculatively. Prioritise callers and direct dependents over transitive dependencies.
3. Report only bugs, regressions, and coverage gaps you can ground in the diff or a file you have actually read. Do not speculate.
4. Focus on new and materially changed code paths. Do not flag pre-existing issues that this diff did not touch.
5. Intent-alignment check (only if intent is known — see step 1): compare what the diff actually does against the stated intent. If the implementation doesn't do what was described — something promised is missing, partially done, or the diff does something materially different or additional that the description doesn't mention — raise it as its own finding card in Section 2, titled starting with "Intent mismatch:". In that card's **Root cause**, quote or closely paraphrase the specific part of the stated intent and state exactly what the diff does instead. Score its severity using the same BLOCKER/P1/P2/P3 rubric below (a mismatch that ships silently broken behavior is at least P1; a scope difference that's harmless is P3). Do not raise this finding type at all if intent was unknown per step 1 — an absent or unreadable description is not itself a finding.
6. For each finding, complete every field of the card. No partial cards.

---

## Output Format

### Section 1 — Executive Summary
Two to three sentences maximum. State the **Risk Level** (Low / Medium / High / Critical) and **Recommendation** (Approve / Request Changes / Block) on their own line.${hasIntent ? "" : " Also note in one clause that intent could not be assessed (no usable PR description or linked content)."}

---

### Section 2 — Findings

One card per finding. Severity order: BLOCKER → P1 → P2 → P3.

Severity definitions:
- **BLOCKER** — will cause a crash, data corruption, service outage, or security breach in production
- **P1** — significant functional regression or broken contract; must fix before deploy
- **P2** — missing error handling, partial implementation, or observability gap; fix before release
- **P3** — code quality, style, or minor inconsistency; fix at discretion

Use this exact card format for every finding. Do not deviate from it:

\`\`\`
---
**[SEVERITY-N]** Short title — max 10 words
**File:** path/to/file.ts · line X or lines X–Y
**Root cause:** One sentence — what is wrong in the code and why.
**Impact:** One sentence — what fails, for whom, and how severely.
**Fix:** Concrete change — pseudocode or real code snippet if helpful.
---
\`\`\`

Example (copy the bold markers exactly as shown):

\`\`\`
---
**[BLOCKER-1]** Null dereference when vehicle has no active subscription
**File:** src/enrollers/ford/enroller.ts · lines 42–45
**Root cause:** getConfig() returns undefined for unsubscribed vehicles but line 43 dereferences .timeout unconditionally.
**Impact:** Service throws TypeError on every Ford enroll request for unsubscribed vehicles, causing 500s.
**Fix:** Add \`if (!config) return Result.err("no_active_subscription")\` before line 43.
---
\`\`\`

Rules:
- Only the labels (**[SEVERITY-N]**, **File:**, **Root cause:**, **Impact:**, **Fix:**) are bold — not the values.
- No other text in the card is bold, italic, or formatted.

_If no findings at or above the severity threshold: write "No findings."_

---

### Section 3 — Test Gaps

One row per missing scenario. Only include gaps for new or materially changed code paths.

| Priority | Test Type | File / Function | Missing Scenario | What to Assert |
|---|---|---|---|---|

Test type key: **UT** = unit · **IT** = integration · **CT** = component · **CN** = contract

_If no gaps: write "No test gaps identified."_

---

### Section 4 — Regression Risk

One row per existing flow this diff touches.

| Flow / Behaviour | Risk (Safe / Risky / Breaking) | Reason |
|---|---|---|

_If no regressions: write "No regression risks identified."_

---

## Diff and Metadata
${diffMarkdown}

---

${hasCodeContext ? `## Related Code Context (import graph of changed files)\n${codeContext}\n\n---\n\n` : ""}## Existing Test Coverage
${hasTests ? testCoverageSummary : "_No test paths provided — flag coverage gaps based on the diff alone._"}

---

Produce the review now. Be precise. Every finding must be grounded in the diff or a file you have read.`;
}
