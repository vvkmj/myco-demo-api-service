import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./llm/llmClientFactory";
import { fetchDiffContext, formatDiffContext } from "./github/prFetcher";
import { cloneTargetRepo, deriveSparseFolders } from "./repo/repoManager";
import { scanTestCoverage, autoDiscoverTests } from "./tests/testScanner";
import { buildCodeContext, deriveEntryPoints } from "./code/codeWalker";
import { reviewPR, Severity } from "./review/prReviewer";
import { postReviewComments, postConfirmedInlineComments, postTicketLinks, fetchAlreadyRaisedFindings, AlreadyRaisedResult } from "./github/prCommenter";
import { parseFindings } from "./review/finding";
import { validateFindings, buildValidationSection, ValidatedFinding } from "./validate/findingValidator";
import { createTicketCreator } from "./tickets/ticketCreator";
import { writeFindingsJson, loadTicketHashes, saveTicketHash } from "./output/findingsExporter";
import { reportMetrics } from "./output/metricsReporter";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌  Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🤖  PR Reviewer Agent — Senior SDET\n");

  const inputUrl  = requireEnv("PR_LINK");
  const outputBase = process.env.OUTPUT_DIR || "./reviews";
  const minSeverity = (process.env.MIN_SEVERITY || "P3") as Severity;
  const postComments = process.env.POST_GITHUB_COMMENTS === "true";

  // ── 1. LLM client (provider selected via LLM_PROVIDER — "openai" default) ──
  const claude = createLLMClient();

  // ── 2. Fetch diff from GitHub (PR or compare URL) ────────────────────────
  let diff;
  try {
    diff = await fetchDiffContext(inputUrl);
    const label = diff.sourceType === "pr"
      ? `PR #${diff.prNumber} — "${diff.title}"`
      : `Compare ${diff.baseRef}...${diff.headRef}`;
    console.log(`✅  Fetched: "${label}" (${diff.changedFiles.length} files changed)`);
    console.log(
      `    +${diff.changedFiles.reduce((s, f) => s + f.additions, 0)} / ` +
        `-${diff.changedFiles.reduce((s, f) => s + f.deletions, 0)} lines`
    );
  } catch (err: any) {
    console.error("❌  Failed to fetch diff:", err.message);
    process.exit(1);
  }

  const diffMarkdown = formatDiffContext(diff);

  // ── 3. Clone / pull target repo ──────────────────────────────────────────
  // AUTO-DERIVE: if TARGET_REPO is not set, default to the repo the PR belongs to.
  // TARGET_BRANCH defaults to the PR's head branch so the clone reflects the PR's changes.
  const repoUrl  = process.env.TARGET_REPO
    || `https://github.com/${diff.owner}/${diff.repo}`;
  const branch   = process.env.TARGET_BRANCH
    || (diff.sourceType === "pr" ? diff.headRef : diff.baseRef);
  const repoPath = process.env.TARGET_REPO_PATH || "./target-repo";
  const sparseFolders = deriveSparseFolders(diff.changedFiles.map((f) => f.filename));

  cloneTargetRepo(repoUrl, branch, repoPath, sparseFolders);

  // ── 4. Build static code context from import graph ──────────────────────
  let codeContext: string | undefined;
  if (repoPath) {
    console.log("\n🗺️   Building code context (import graph)...");
    const entryPoints = deriveEntryPoints(
      diff.changedFiles.map((f) => f.filename),
      repoPath
    );
    if (entryPoints.length > 0) {
      const ctx = buildCodeContext(entryPoints, repoPath);
      codeContext = ctx.content;
      console.log(
        `✅  Code context built — ${ctx.files.length} file(s)` +
        (ctx.truncated ? " (truncated at char limit)" : "")
      );
    } else {
      console.log("  ⚠️   No local source entry points found — skipping code context.");
    }
  }

  // ── 5. Scan existing tests ──────────────────────────────────────────────
  console.log("\n🔍  Scanning test coverage...");

  const autoFound = repoPath
    ? autoDiscoverTests(repoPath, sparseFolders)
    : undefined;

  if (autoFound) {
    const autoTotal =
      autoFound.unit.length + autoFound.integration.length +
      autoFound.component.length + autoFound.contract.length;
    if (autoTotal > 0) {
      console.log(
        `  🔎  Auto-discovered — ` +
          `UTs: ${autoFound.unit.length}, ` +
          `ITs: ${autoFound.integration.length}, ` +
          `Component: ${autoFound.component.length}, ` +
          `Contract: ${autoFound.contract.length}`
      );
    }
  }

  const testCoverage = scanTestCoverage(
    {
      unit: parseList(process.env.UT_PATH),
      integration: parseList(process.env.IT_PATH),
      component: parseList(process.env.COMPONENT_TEST_PATH),
      contract: parseList(process.env.CONTRACT_TEST_PATH),
    },
    [],
    autoFound
  );

  const totalTests =
    testCoverage.byType.unit.length +
    testCoverage.byType.integration.length +
    testCoverage.byType.component.length +
    testCoverage.byType.contract.length;

  console.log(
    `✅  Tests scanned — ` +
      `UTs: ${testCoverage.byType.unit.length}, ` +
      `ITs: ${testCoverage.byType.integration.length}, ` +
      `Component: ${testCoverage.byType.component.length}, ` +
      `Contract: ${testCoverage.byType.contract.length}`
  );

  if (totalTests === 0) {
    console.log("  ⚠️   No tests found — coverage gaps will be derived from the diff only.");
  }

  // ── 6. Run review ────────────────────────────────────────────────────────
  console.log(`\n🧠  Running SDET review (min severity: ${minSeverity})...`);

  const outputDir = path.join(outputBase, `${diff.owner}_${diff.repo}_${diff.slug}`);

  const { outputPath, reviewMarkdown } = await reviewPR(
    {
      diff,
      diffMarkdown,
      repoPath: repoPath ?? undefined,
      codeContext,
      testCoverageSummary: testCoverage.summary,
      outputDir,
      minSeverity,
    },
    claude
  );

  const validateEnabled = process.env.VALIDATE_FINDINGS === "true";

  // ── 7. Post findings as GitHub PR comments (PR-only, pre-validation) ────────
  // Skipped when VALIDATE_FINDINGS=true — we wait until after validation so
  // only confirmed findings are posted as inline comments (see step 9b below).
  if (postComments && !validateEnabled) {
    if (diff.sourceType !== "pr") {
      console.log("\nℹ️   POST_GITHUB_COMMENTS=true but input is a compare URL — skipping (no PR to comment on).");
    } else {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        console.warn("\n⚠️   POST_GITHUB_COMMENTS=true but GITHUB_TOKEN is not set — skipping.");
      } else {
        console.log("\n💬  Posting findings to GitHub PR...");
        try {
          const posted = await postReviewComments(diff, reviewMarkdown, token);
          console.log(`✅  Posted ${posted} comment(s) to PR #${diff.prNumber}.`);
        } catch (err: any) {
          console.warn(`⚠️   Failed to post GitHub comments: ${err.message}`);
        }
      }
    }
  }

  // ── 8. Parse findings + write base findings.json ─────────────────────────
  const rawFindings = parseFindings(reviewMarkdown);
  console.log(`\n📋  Parsed ${rawFindings.length} finding(s) from review.`);

  // Auto-detect Jira: if all three credentials are present, enable ticket creation
  // without requiring CREATE_TICKETS=true to be set explicitly. GitHub Issues
  // needs no separate credentials (reuses GITHUB_TOKEN), so explicitly setting
  // TICKET_PROVIDER=github-issues is itself enough to auto-enable it.
  const jiraConfigured   = !!(
    process.env.JIRA_BASE_URL && process.env.JIRA_TOKEN && process.env.JIRA_PROJECT
  );
  const ticketProviderEnv = process.env.TICKET_PROVIDER;
  const createTickets  = process.env.CREATE_TICKETS === "true"
    || jiraConfigured
    || ticketProviderEnv === "github-issues";
  const ticketProvider = (ticketProviderEnv ||
    (jiraConfigured ? "jira" : "dry-run")) as "jira" | "github-issues" | "dry-run";
  // Which confirmed findings get a ticket: the historical default only files
  // for merge-blocking bugs (Jira's implicit "needs action now" framing).
  // "all-confirmed" is for cases like GitHub Issues used purely for metrics
  // (counting every confirmed bug, not just the ones that block a merge).
  const ticketScope    = (process.env.CREATE_TICKETS_FOR || "merge-blocking") as
    "merge-blocking" | "all-confirmed";
  const ciGate         = process.env.CI_GATE !== "false"; // default true when validation runs

  const SEVERITY_RANK: Record<string, number> = { BLOCKER: 0, P1: 1, P2: 2, P3: 3 };

  // Write an initial (unvalidated) findings.json immediately
  let findingsJsonPath = writeFindingsJson(outputDir, inputUrl, reviewMarkdown, rawFindings, false);
  console.log(`   📄  ${findingsJsonPath}`);

  // ── 9. Validate findings (second-pass) ───────────────────────────────────
  let validatedFindings: ValidatedFinding[] = [];

  if (validateEnabled) {
    if (rawFindings.length === 0) {
      console.log("\nℹ️   No findings to validate.");
    } else {
      // Use a separate model for validation if configured
      const validatorClaude = process.env.VALIDATOR_MODEL
        ? createLLMClient(process.env.VALIDATOR_MODEL)
        : claude;

      validatedFindings = await validateFindings(
        rawFindings,
        diffMarkdown,
        repoPath ?? undefined,
        codeContext,
        validatorClaude
      );

      // ── 9c. Fetch already-raised findings from PR comments ────────────────
      // Reads existing inline review threads and "Jira Tickets Filed" issue
      // comments to detect bugs that were already commented on and ticketed in
      // a previous Zenith run. Used to suppress duplicate inline comments and
      // duplicate ticket creation below.
      let alreadyRaised: AlreadyRaisedResult | undefined;
      if (diff.sourceType === "pr") {
        const prToken = process.env.GITHUB_TOKEN;
        if (prToken) {
          console.log("\n🔍  Checking PR for already-raised findings...");
          try {
            alreadyRaised = await fetchAlreadyRaisedFindings(diff, prToken);
            const ticketedCount =
              alreadyRaised.ticketedByPosition.size + alreadyRaised.ticketedById.size;
            if (ticketedCount > 0) {
              console.log(
                `  ℹ️   ${ticketedCount} finding(s) already raised in PR — ` +
                `will skip re-commenting and re-ticketing.`
              );
            } else {
              console.log("  ✅  No previously-raised findings detected.");
            }
          } catch (err: any) {
            console.warn(`⚠️   Could not check PR for already-raised findings: ${err.message}`);
          }
        }
      }

      // ── 10. Create tickets for confirmed findings ───────────────────────
      if (createTickets && validatedFindings.length > 0) {
        console.log(`\n🎫  Creating tickets (provider: ${ticketProvider}, scope: ${ticketScope})...`);
        const ticketCreator = createTicketCreator(ticketProvider);
        const hashes = loadTicketHashes(outputDir);

        for (const finding of validatedFindings) {
          if (finding.verdict !== "CONFIRMED") continue;
          if (ticketScope === "merge-blocking" && !finding.mergeBlocking) continue;

          // Skip if this finding was already raised in the PR (ticket detected in
          // existing PR comments from a previous run).
          if (alreadyRaised) {
            const pos =
              finding.filePath && finding.line != null
                ? `${finding.filePath}:${finding.line}`
                : null;
            const existingUrl =
              (pos ? alreadyRaised.ticketedByPosition.get(pos) : undefined) ??
              alreadyRaised.ticketedById.get(finding.id);
            if (existingUrl !== undefined) {
              console.log(
                `  ℹ️   [${finding.id}] Already raised in PR — ${existingUrl} — skipping ticket creation.`
              );
              if (!finding.ticketUrl) finding.ticketUrl = existingUrl;
              continue;
            }
          }

          if (hashes[finding.hash]) {
            console.log(`  ℹ️   [${finding.id}] Already filed — ${hashes[finding.hash]}`);
            finding.ticketUrl = hashes[finding.hash];
            continue;
          }

          let lastErr: any;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const url = await ticketCreator.create(finding, inputUrl, diff.author);
              if (url) {
                finding.ticketUrl = url;
                saveTicketHash(outputDir, finding.hash, url);
                console.log(`  ✅  [${finding.id}] Ticket created — ${url}`);
              }
              lastErr = undefined;
              break;
            } catch (err: any) {
              lastErr = err;
              const detail = err.response
                ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`
                : err.message;
              if (attempt < 3) {
                console.warn(`  ⚠️   [${finding.id}] Attempt ${attempt} failed: ${detail} — retrying in ${attempt * 2}s...`);
                await new Promise((r) => setTimeout(r, attempt * 2000));
              }
            }
          }
          if (lastErr) {
            const detail = lastErr.response
              ? `HTTP ${lastErr.response.status}: ${JSON.stringify(lastErr.response.data).slice(0, 300)}`
              : lastErr.message;
            console.warn(`  ⚠️   [${finding.id}] Failed to create ticket after 3 attempts: ${detail}`);
          }
        }

      }

      // ── 9b. Post confirmed findings as inline PR comments ─────────────────
      if (postComments && diff.sourceType === "pr") {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          console.warn("\n⚠️   POST_GITHUB_COMMENTS=true but GITHUB_TOKEN is not set — skipping confirmed inline comments.");
        } else {
          console.log("\n💬  Posting confirmed findings as inline PR comments...");
          try {
            const posted = await postConfirmedInlineComments(diff, validatedFindings, token, alreadyRaised);
            if (posted > 0) {
              console.log(`✅  Posted ${posted} confirmed finding(s) to PR #${diff.prNumber}.`);
            }
          } catch (err: any) {
            console.warn(`⚠️   Failed to post confirmed inline comments: ${err.message}`);
          }

          // Post a separate PR comment listing all Jira ticket links
          try {
            await postTicketLinks(diff, validatedFindings, token);
          } catch (err: any) {
            console.warn(`⚠️   Failed to post Jira ticket links comment: ${err.message}`);
          }


        }
      }

      // Append Section 5 (validation results) to the review markdown file
      const validationSection = buildValidationSection(validatedFindings);
      if (validationSection) {
        fs.appendFileSync(outputPath, validationSection, "utf-8");
        console.log(`\n✅  Validation section appended to review.`);
      }

      // Overwrite findings.json with validated data
      findingsJsonPath = writeFindingsJson(outputDir, inputUrl, reviewMarkdown, validatedFindings, true);
      console.log(`   📄  ${findingsJsonPath} (updated with validation results)`);

      // ── 9d. Report metrics (opt-in — no-op unless METRICS_ENDPOINT is set) ──
      await reportMetrics(diff, inputUrl, validatedFindings);
    }
  }

  // ── 11. CI gate ──────────────────────────────────────────────────────────
  if (validateEnabled && ciGate) {
    // GATE_MIN_SEVERITY caps which severity levels can block the merge,
    // independently of MIN_SEVERITY (which controls what the LLM generates).
    // e.g. MIN_SEVERITY=P2 + GATE_MIN_SEVERITY=P1 → P2 findings are generated
    // and commented on the PR, but only confirmed P1/BLOCKER findings block it.
    const gateSeverity = process.env.GATE_MIN_SEVERITY || "P1";
    const gateRank = SEVERITY_RANK[gateSeverity] ?? 1;

    const confirmedBlockers = validatedFindings.filter(
      (f) => f.verdict === "CONFIRMED" && f.mergeBlocking &&
             (SEVERITY_RANK[f.severity] ?? 99) <= gateRank
    );
    if (confirmedBlockers.length > 0) {
      console.error(
        `\n❌  ${confirmedBlockers.length} confirmed merge-blocking bug(s) found:` +
        confirmedBlockers.map((f) => `\n     [${f.id}] ${f.title}`).join("")
      );
      console.error("   PR is blocked from merging.");
      process.exit(1);
    } else {
      console.log("\n✅  No confirmed merge-blocking bugs — PR may proceed.");
    }
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log(`\n✅  Done!`);
  console.log(`   📄  ${outputPath}`);
}

main().catch((err) => {
  console.error("❌  Fatal error:", err);
  process.exit(1);
});
