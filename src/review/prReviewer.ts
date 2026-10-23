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
  /** Cross-repository analysis context to inject into prompt. */
  crossRepoContext?: string;
  /** Map of repo slugs/prefixes to local directories for multi-repo read_file tool calls. */
  repoPathMap?: Map<string, string>;
  /** Requirement & Jira context from folder attachments and specs. */
  requirementContext?: string;
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
  const { diff, diffMarkdown, repoPath, codeContext, testCoverageSummary, outputDir, minSeverity, linkedContext, crossRepoContext, repoPathMap, requirementContext } = input;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${diff.slug}_review.md`;
  const outputPath = path.join(outputDir, filename);

  // Open a write stream so the review is written progressively as chunks arrive.
  // Terminal output is suppressed inside generate() when a stream is passed.
  const fileStream = fs.createWriteStream(outputPath, { encoding: "utf-8" });
  console.log(`\n🔬 Running SDET review... (streaming → ${outputPath})`);

  const prompt = buildReviewPrompt(diff, diffMarkdown, codeContext, testCoverageSummary, minSeverity, linkedContext, crossRepoContext, requirementContext);
  const review = await claude.generate(prompt, repoPath, fileStream, repoPathMap);

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
  linkedContext?: string,
  crossRepoContext?: string,
  requirementContext?: string
): string {
  const hasTests = testCoverageSummary.trim().length > 0;
  const hasCodeContext = !!codeContext && codeContext.trim().length > 0;
  const thresholdNote = severityThresholdNote(minSeverity);
  const hasIntent = !!diff.description?.trim() || !!linkedContext;

  const header =
    diff.sourceType === "pr"
      ? `**PR #${diff.prNumber} — "${diff.title}"**\nRepo: ${diff.owner}/${diff.repo} · Branch: \`${diff.headRef}\` → \`${diff.baseRef}\``
      : diff.sourceType === "local"
      ? `**Local Folder Changes — "${diff.title}"**\nFolder: ${diff.owner}/${diff.repo} · \`${diff.headRef}\` (base: \`${diff.baseRef}\`)`
      : `**Tag diff — "${diff.title}"**\nRepo: ${diff.owner}/${diff.repo} · \`${diff.baseRef}\` → \`${diff.headRef}\` (${diff.commits.length} commits)`;

  const inputLabel = diff.sourceType === "pr" ? "PR" : diff.sourceType === "local" ? "local changes" : "release";
  const intentSection = buildIntentSection(diff, linkedContext);

  return `You are a senior SDET reviewing a production ${inputLabel}. Be precise and concise — no filler prose.
${thresholdNote}
${header}

---

${intentSection}

---

${requirementContext ? `${requirementContext}\n\n---\n\n` : ""}## Instructions

1. Start with the Stated Intent and Documented Requirements sections above. Before looking at any code, understand what this change is supposed to accomplish and what acceptance criteria apply. If intent/requirements are unknown, say so explicitly later rather than guessing.
2. Read the diff below. Each diff line is prefixed with its absolute file line number: \`+44: added code\`, \` 44: context\`, \`-43: removed code\`. Use these numbers directly when filling in the **File:** field — do not recount from @@ headers. The code context section already includes the changed files and their direct import dependencies. Use the \`read_file\` tool only for files you cannot see yet but have specific reason to check — for example: a caller of a changed function (look for the import path in the code context or diff), a file that re-exports a changed symbol, or a sibling module in the same package. Read files by their exact path; do not guess speculatively. Prioritise callers and direct dependents over transitive dependencies.
3. Report only bugs, regressions, coverage gaps, and requirement mismatches you can ground in the diff or a file you have actually read. Do not speculate.
4. Focus on new and materially changed code paths. Do not flag pre-existing issues that this diff did not touch.
5. Requirement Compliance and Intent Checks:
   a. **Requirement Failure / Non-compliance**: If the code violates any documented requirement, schema rule, or fails any acceptance criterion from the attached docs/jira, raise a finding titled \`Requirement mismatch: <short description>\`. In Root cause, cite the specific requirement/criterion and what the code fails to do. Score as **BLOCKER** or **P1** (Merge-blocking: yes).
   b. **Requirement Change to Code Mismatch**: If requirements in docs/jira were modified in this change (see Requirement Change Analysis above) but the code does not implement the new requirement or retains obsolete/removed behavior, raise a finding titled \`Requirement change mismatch: <short description>\`. Score as **BLOCKER** or **P1** (Merge-blocking: yes).
   c. **Unnecessary Changes / Scope Creep**: If the diff introduces code changes, refactoring, extra functions, or configuration alterations that are **NOT required or justified** by the attached docs/jira or stated intent, raise a finding titled \`Unnecessary change: <short description>\` or \`Scope creep: <short description>\`. In the **Fix** field, provide a concrete suggestion to remove, revert, or separate the change into another PR. Score as **P2** or **P3** (or **P1** if introducing significant regression risk).
   d. **Intent Mismatch**: If the PR description stated an intent that is not implemented or contradicted, raise a finding titled \`Intent mismatch: <short description>\`.
   e. **Downstream Breaking Changes (Cross-Repository)**: Review the "Cross-Repository Context" and any downstream consumer call-sites. If this PR modifies an export (e.g. adding required arguments, changing parameter types, altering return types, removing/renaming interface properties, or altering runtime semantics) that is consumed by an external repository, and that modification breaks any consumer call-site or contract, raise a finding titled \`Downstream breaking change: <short description>\`. In Root cause, cite both the changed PR code and the external consumer repo's specific file/line call-site. Score as **BLOCKER** or **P1** (Merge-blocking: yes).
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

${crossRepoContext ? `${crossRepoContext}\n\n---\n\n` : ""}${hasCodeContext ? `## Related Code Context (import graph of changed files)\n${codeContext}\n\n---\n\n` : ""}## Existing Test Coverage
${hasTests ? testCoverageSummary : "_No test paths provided — flag coverage gaps based on the diff alone._"}

---

Produce the review now. Be precise. Every finding must be grounded in the diff or a file you have read.`;
}
