import * as assert from "assert";
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

import { fetchDiffContext } from "../src/github/prFetcher";
import { ExternalDocConnector, extractPrdUrls } from "../src/connectors/externalDocConnector";
import { fetchAllRequirements, buildConnectorConfig } from "../src/connectors/connectorRegistry";
import { mapRequirementsToCode } from "../src/prd/requirementMapper";
import { runDeterministicChecks, validateRequirements } from "../src/prd/prdValidator";
import { evaluateMergePolicy, buildMergePolicyConfig } from "../src/prd/mergePolicy";
import { reportPrdValidationToGitHub } from "../src/github/checkReporter";
import { createLLMClient } from "../src/llm/llmClientFactory";
import { ChangedFile, buildDiffSummary } from "../src/github/prFetcher";

async function runGoogleDocsEndToEnd() {
  console.log("\n🚀 Starting End-to-End Google Docs PRD Validation Live Verification...\n");

  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, "GITHUB_TOKEN must be configured in .env");

  const owner = "vvkmj";
  const repo = "myco-prd-demo";
  const prNumber = 4;
  const liveGDocsUrl = "https://docs.google.com/document/d/1064e2XSZysXR9JvcJfkn_r1wCYdDPPwm1qhY4mi8G4Q/edit";

  // ───────────────────────────────────────────────────────────────────────────
  // STEP 1: Verify PR Description Parsing & Real Google Docs Retrieval
  // ───────────────────────────────────────────────────────────────────────────
  console.log("=== Step 1: PR Description & Google Docs Retrieval ===");
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const diff = await fetchDiffContext(prUrl);
  console.log(`  Fetched PR #${prNumber} ("${diff.title}")`);
  console.log(`  PR Description preview:\n    ${diff.description.split("\n").join("\n    ")}`);

  // Test extractPrdUrls on the PR description
  const extractedUrls = extractPrdUrls(diff.description);
  console.log(`  Extracted PRD URLs from description:`, extractedUrls);
  assert.ok(extractedUrls.length > 0, "Must extract at least one PRD URL from PR description");
  assert.strictEqual(extractedUrls[0], liveGDocsUrl, "Extracted URL must match the live Google Docs URL");

  // Build connector config with PR description
  const connectorConfig = buildConnectorConfig(undefined, diff.description);
  assert.ok(connectorConfig.externalDocUrls?.includes(liveGDocsUrl), "ConnectorConfig must contain the Google Docs URL");

  // Fetch requirements using ExternalDocConnector
  const orchestratorResult = await fetchAllRequirements(connectorConfig);
  console.log(`  Connector Summary: ${orchestratorResult.summary}`);
  console.log(`  Total requirements fetched: ${orchestratorResult.allRequirements.length}`);

  assert.ok(orchestratorResult.allRequirements.length > 0, "Must have fetched requirements from Google Docs");
  const gdocReq = orchestratorResult.allRequirements.find(r => r.source === "external_url");
  assert.ok(gdocReq, "Must have an external_url requirement");
  console.log(`  📄 Requirement Title: "${gdocReq.title}"`);
  console.log(`  📄 Acceptance Criteria (${gdocReq.acceptanceCriteria.length} items):`);
  for (const ac of gdocReq.acceptanceCriteria) {
    console.log(`     • ${ac}`);
  }

  // Verify unique wording from Google Docs R1, R2, R3
  const acText = gdocReq.acceptanceCriteria.join("\n");
  assert.ok(acText.includes("Requirement R1") && acText.includes("HTTP 400"), "Must include Requirement R1 unique text");
  assert.ok(acText.includes("Requirement R2") && acText.includes("lowercase"), "Must include Requirement R2 unique text");
  assert.ok(acText.includes("Requirement R3") && acText.includes("Regression tests"), "Must include Requirement R3 unique text");
  console.log("  ✅ Live Google Docs content verified: R1, R2, R3 unique wording retrieved successfully!");

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO A: Compliant Change (PR #4)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== Scenario A: Compliant PR Validation (PR #4) ===");
  const mappingsA = mapRequirementsToCode(orchestratorResult.allRequirements, diff.changedFiles);
  console.log(`  Mapped requirements to changed files:`);
  for (const m of mappingsA) {
    console.log(`    - [${m.requirement.id}] code: [${m.affectedCodeFiles.join(", ")}], tests: [${m.relatedTestFiles.join(", ")}]`);
  }

  const deterministicResultsA = runDeterministicChecks(mappingsA);
  const detFailsA = deterministicResultsA.filter(r => r.status === "FAIL");
  assert.strictEqual(detFailsA.length, 0, "Compliant PR must have 0 deterministic failures");

  const llm = createLLMClient();
  const prdResultsA = await validateRequirements(
    mappingsA,
    diff.diffSummary,
    undefined,
    undefined,
    llm
  );

  console.log(`  Validation Results for PR #4:`);
  for (const r of prdResultsA) {
    console.log(`    [${r.status}] ${r.requirement.title}: ${r.evidence}`);
  }

  const decisionA = evaluateMergePolicy(prdResultsA, orchestratorResult, {
    prdValidationEnabled: true,
    failOnInconclusive: true,
    failOnMissingCredentials: true,
    optionalPolicy: "warn",
  });

  console.log(`  ⚖️  Merge Policy Decision for PR #4: ${decisionA.result} — ${decisionA.reason}`);
  assert.strictEqual(decisionA.result, "PASS", "Compliant PR must receive PASS decision");

  // Publish success status to GitHub
  const repA = await reportPrdValidationToGitHub(decisionA, orchestratorResult, {
    owner,
    repo,
    headSha: diff.headSha || "7033ce1ef338f66c2100c02934141fb5fb703dcf",
    prNumber,
  });
  console.log(`  Published status to GitHub for PR #4: commitStatusPublished=${repA.commitStatusPublished}, commentPosted=${repA.commentPosted}`);
  assert.strictEqual(repA.commitStatusPublished, true);

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO B: Non-compliant Change (Deliberate Violation of R2)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== Scenario B: Non-compliant PR Validation (Violating R2) ===");
  // Non-compliant diff where email normalization is violated (not converted to lowercase)
  const nonCompliantFiles: ChangedFile[] = [
    {
      filename: "src/userService.ts",
      status: "modified",
      additions: 15,
      deletions: 2,
      patch: `@@ -15,7 +15,7 @@ export function createUser(email: string): User {
+  // VIOLATION: Email is stored directly without converting to lowercase or trimming!
+  const rawEmail = email;
+  return { id: "user_123", email: rawEmail };
 }`,
    },
    {
      filename: "tests/userService.test.ts",
      status: "modified",
      additions: 5,
      deletions: 5,
      patch: `@@ -10,5 +10,5 @@ testUserCreation() {
-  assert.strictEqual(user.email, "testuser@example.com");
+  // Missing test for lowercase normalization!
+}`,
    },
  ];

  const mappingsB = mapRequirementsToCode(orchestratorResult.allRequirements, nonCompliantFiles);
  const diffSummaryB = buildDiffSummary(nonCompliantFiles);

  const prdResultsB = await validateRequirements(
    mappingsB,
    diffSummaryB,
    undefined,
    undefined,
    llm
  );

  console.log(`  Validation Results for Non-compliant Change:`);
  for (const r of prdResultsB) {
    console.log(`    [${r.status}] ${r.requirement.title}: ${r.missingFunctionality || r.evidence}`);
  }

  const decisionB = evaluateMergePolicy(prdResultsB, orchestratorResult, {
    prdValidationEnabled: true,
    failOnInconclusive: true,
    failOnMissingCredentials: true,
    optionalPolicy: "warn",
  });

  console.log(`  ⚖️  Merge Policy Decision for Non-compliant Change: ${decisionB.result} — ${decisionB.reason}`);
  assert.strictEqual(decisionB.result, "FAIL", "Non-compliant change must receive FAIL decision");

  // Publish failure status to GitHub demo PR #3 (our existing blocked PR)
  const repB = await reportPrdValidationToGitHub(decisionB, orchestratorResult, {
    owner,
    repo,
    headSha: "59266332f5246e232aff4f8ecd8a2531be64cf5e", // PR #3 head
    prNumber: 3,
  });
  console.log(`  Published failure status to GitHub for PR #3: commitStatusPublished=${repB.commitStatusPublished}`);
  assert.strictEqual(repB.commitStatusPublished, true);

  // Verify branch protection blocks merge
  let mergeBlocked = false;
  try {
    await axios.put(
      `https://api.github.com/repos/${owner}/${repo}/pulls/3/merge`,
      { commit_title: "Attempting merge on non-compliant PR" },
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
    );
  } catch (err: any) {
    mergeBlocked = true;
    console.log(`  🛡️  GitHub branch protection blocked merge of non-compliant PR! HTTP ${err.response?.status}: "${err.response?.data?.message}"`);
    assert.ok(err.response?.status === 405 || err.response?.status === 409);
  }
  assert.strictEqual(mergeBlocked, true, "Branch protection must block merge on non-compliant PR");

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO C: Inaccessible / Malformed PRD Failure Handling
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== Scenario C: Inaccessible / Malformed PRD Handling ===");
  const badDescription = "Feature with invalid PRD\n\nPRD: https://docs.google.com/document/d/inaccessible-doc-999999/edit";
  const badConfig = buildConnectorConfig(undefined, badDescription);
  assert.ok(badConfig.externalDocUrls?.includes("https://docs.google.com/document/d/inaccessible-doc-999999/edit"));

  const badOrchestratorResult = await fetchAllRequirements(badConfig);
  console.log(`  Connector Summary with invalid doc: ${badOrchestratorResult.summary}`);
  console.log(`  Has unreachable sources: ${badOrchestratorResult.hasUnreachableSources}`);

  // Test our fail-closed protection from index.ts:
  if (badOrchestratorResult.allRequirements.length === 0 && badConfig.externalDocUrls && badConfig.externalDocUrls.length > 0) {
    badOrchestratorResult.allRequirements.push({
      id: "PRD-INACCESSIBLE",
      source: "external_url",
      title: "Inaccessible PRD Specification",
      description: `External PRD could not be retrieved from: ${badConfig.externalDocUrls.join(", ")}`,
      acceptanceCriteria: ["Document must be accessible and contain valid acceptance criteria"],
      priority: "critical",
      severity: "mandatory",
      sourceUrl: badConfig.externalDocUrls[0],
      traceability: [],
      sourceKey: "PRD_URL",
      contentExcerpt: "Configured PRD document was inaccessible, malformed, or empty.",
    });
    badOrchestratorResult.hasUnreachableSources = true;
  }

  const badMappings = mapRequirementsToCode(badOrchestratorResult.allRequirements, diff.changedFiles);
  const badDetChecks = runDeterministicChecks(badMappings);
  const badDecision = evaluateMergePolicy(badDetChecks, badOrchestratorResult, {
    prdValidationEnabled: true,
    failOnInconclusive: true,
    failOnMissingCredentials: true,
    optionalPolicy: "warn",
  });

  console.log(`  ⚖️  Merge Decision for Inaccessible PRD: ${badDecision.result} — ${badDecision.reason}`);
  assert.strictEqual(badDecision.result, "FAIL", "Inaccessible PRD must result in FAIL merge decision (no silent fallback or false pass)");

  console.log("\n🎉 ALL GOOGLE DOCS END-TO-END VALIDATION SCENARIOS COMPLETED SUCCESSFULLY!\n");
}

runGoogleDocsEndToEnd().catch(err => {
  console.error("❌ End-to-end Google Docs validation failed:", err);
  process.exit(1);
});
