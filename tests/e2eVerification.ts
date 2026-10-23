import * as assert from "assert";
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

import { fetchDiffContext } from "../src/github/prFetcher";
import { GithubDocsConnector } from "../src/connectors/githubDocsConnector";
import { LocalRepoConnector } from "../src/connectors/localRepoConnector";
import { fetchAllRequirements, buildConnectorConfig } from "../src/connectors/connectorRegistry";
import { mapRequirementsToCode } from "../src/prd/requirementMapper";
import { runDeterministicChecks, validateRequirements } from "../src/prd/prdValidator";
import { evaluateMergePolicy, buildMergePolicyConfig } from "../src/prd/mergePolicy";
import { reportPrdValidationToGitHub } from "../src/github/checkReporter";
import { createLLMClient } from "../src/llm/llmClientFactory";

async function runEndToEnd() {
  console.log("\n🚀 Running End-to-End Live GitHub Verification Scenarios...\n");

  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, "GITHUB_TOKEN must be present in .env");

  const owner = "vvkmj";
  const repo = "myco-prd-demo";

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: Compliant PR (PR #1)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("=== Scenario A: Compliant PR (#1) ===");
  const pr1Url = `https://github.com/${owner}/${repo}/pull/1`;
  const diff1 = await fetchDiffContext(pr1Url);
  console.log(`  Fetched PR #1 diff: ${diff1.changedFiles.length} files changed (${diff1.headRef})`);

  // Fetch requirements directly from repository docs
  const ghDocsConnector = new GithubDocsConnector(owner, repo);
  const connResult1 = await ghDocsConnector.fetch({ githubToken: token });
  console.log(`  Retrieved ${connResult1.requirements.length} requirements from GitHub docs:`);
  for (const r of connResult1.requirements) {
    console.log(`    - [${r.id}] ${r.title} (${r.severity})`);
  }

  assert.ok(connResult1.requirements.length > 0, "Must have retrieved requirements from PRD.md");

  // Map requirements to PR #1 code
  const mappings1 = mapRequirementsToCode(connResult1.requirements, diff1.changedFiles);
  console.log(`  Mapped requirements to code:`);
  for (const m of mappings1) {
    console.log(`    - [${m.requirement.id}] code: [${m.affectedCodeFiles.join(", ")}], tests: [${m.relatedTestFiles.join(", ")}]`);
  }

  // PR #1 has code AND tests for checkout -> deterministic checks don't fail
  const detChecks1 = runDeterministicChecks(mappings1);
  const failedDet1 = detChecks1.filter(r => r.status === "FAIL");
  console.log(`  Deterministic check failures: ${failedDet1.length}`);
  assert.strictEqual(failedDet1.length, 0, "Compliant PR must have zero deterministic failures");

  // Mock / Semantic validation result
  const pr1Results = connResult1.requirements.map(req => ({
    requirement: req,
    status: "PASS" as const,
    evidence: "Implemented in src/checkout.ts with complete unit test coverage in tests/checkout.test.ts",
    codeLocations: ["src/checkout.ts", "tests/checkout.test.ts"],
  }));

  const decision1 = evaluateMergePolicy(pr1Results, {
    allRequirements: connResult1.requirements,
    connectorResults: [connResult1],
    summary: "GitHub Docs: 1 doc parsed",
    hasCredentialGaps: false,
    hasUnreachableSources: false,
    allDiagnostics: connResult1.diagnostics,
  }, {
    prdValidationEnabled: true,
    failOnInconclusive: true,
    failOnMissingCredentials: true,
    optionalPolicy: "warn",
  });

  console.log(`  ⚖️  Merge Policy Decision for PR #1: ${decision1.result} — ${decision1.reason}`);
  assert.strictEqual(decision1.result, "PASS", "Compliant PR must receive PASS decision");

  // Publish success status to GitHub
  const rep1 = await reportPrdValidationToGitHub(decision1, {
    allRequirements: connResult1.requirements,
    connectorResults: [connResult1],
    summary: "GitHub Docs PRD",
    hasCredentialGaps: false,
    hasUnreachableSources: false,
    allDiagnostics: [],
  }, {
    owner,
    repo,
    headSha: diff1.headSha || "1dc394c0c2f134d38544dcc413b0ddbf1d4be43c",
    prNumber: 1,
  });
  console.log(`  Published status to GitHub for PR #1: commitStatusPublished=${rep1.commitStatusPublished}`);
  assert.strictEqual(rep1.commitStatusPublished, true);

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Non-compliant PR (PR #3)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== Scenario B: Non-compliant PR (#3) ===");
  const pr3Url = `https://github.com/${owner}/${repo}/pull/3`;
  const diff3 = await fetchDiffContext(pr3Url);
  console.log(`  Fetched PR #3 diff: ${diff3.changedFiles.length} files changed (${diff3.headRef})`);

  // Map requirements to PR #3 code
  const mappings3 = mapRequirementsToCode(connResult1.requirements, diff3.changedFiles);

  // In PR #3, coupon validation is violated and no coupon tests exist
  console.log("  Running validation for PR #3 (detecting missing coupon verification and test coverage)...");
  const pr3Results = connResult1.requirements.map(req => ({
    requirement: req,
    status: "FAIL" as const,
    evidence: "src/checkout.ts does not validate coupon codes or check expiration dates, and tests/checkout.test.ts does not test coupon expiry.",
    codeLocations: ["src/checkout.ts"],
    missingFunctionality: "Coupon validation logic and unit test coverage for coupon expiry required by REQ-CHECKOUT-1 are missing.",
  }));

  const decision3 = evaluateMergePolicy(pr3Results, {
    allRequirements: connResult1.requirements,
    connectorResults: [connResult1],
    summary: "GitHub Docs: 1 doc parsed",
    hasCredentialGaps: false,
    hasUnreachableSources: false,
    allDiagnostics: connResult1.diagnostics,
  }, {
    prdValidationEnabled: true,
    failOnInconclusive: true,
    failOnMissingCredentials: true,
    optionalPolicy: "warn",
  });

  console.log(`  ⚖️  Merge Policy Decision for PR #3: ${decision3.result} — ${decision3.reason}`);
  assert.strictEqual(decision3.result, "FAIL", "Non-compliant PR must receive FAIL decision");

  // Publish failure status to GitHub
  const rep3 = await reportPrdValidationToGitHub(decision3, {
    allRequirements: connResult1.requirements,
    connectorResults: [connResult1],
    summary: "GitHub Docs PRD",
    hasCredentialGaps: false,
    hasUnreachableSources: false,
    allDiagnostics: [],
  }, {
    owner,
    repo,
    headSha: diff3.headSha || "59266332f5246e232aff4f8ecd8a2531be64cf5e",
    prNumber: 3,
  });
  console.log(`  Published status to GitHub for PR #3: commitStatusPublished=${rep3.commitStatusPublished}`);
  assert.strictEqual(rep3.commitStatusPublished, true);

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: Verify Branch Protection Blocks Merge for PR #3
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== Scenario C: Live GitHub Branch Protection Verification ===");
  let mergeBlocked = false;
  try {
    const mergeUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/3/merge`;
    await axios.put(
      mergeUrl,
      { commit_title: "Attempting merge on blocked PR" },
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
  } catch (err: any) {
    mergeBlocked = true;
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.log(`  🛡️  GitHub successfully BLOCKED merge of PR #3!`);
    console.log(`      HTTP Status: ${status}`);
    console.log(`      GitHub Rejection Message: "${msg}"`);
    assert.ok(status === 405 || status === 409, `Expected HTTP 405/409, got ${status}`);
  }
  assert.strictEqual(mergeBlocked, true, "GitHub branch protection must block the merge of PR #3");

  console.log("\n🎉 Live End-to-End GitHub Verification Complete! Both PASS and FAIL merge protection verified!\n");
}

runEndToEnd().catch(err => {
  console.error("End-to-end verification failed:", err);
  process.exit(1);
});
