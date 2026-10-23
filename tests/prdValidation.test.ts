import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  NormalizedRequirement,
  RequirementValidationResult,
  ValidationStatus,
  ConnectorConfig,
} from "../src/connectors/types";
import { JiraConnector } from "../src/connectors/jiraConnector";
import { ConfluenceConnector } from "../src/connectors/confluenceConnector";
import { ExternalDocConnector, toGoogleDocsExportUrl } from "../src/connectors/externalDocConnector";
import { LocalRepoConnector } from "../src/connectors/localRepoConnector";
import { fetchAllRequirements, buildConnectorConfig } from "../src/connectors/connectorRegistry";
import { mapRequirementsToCode, RequirementMapping } from "../src/prd/requirementMapper";
import { runDeterministicChecks, validateRequirements } from "../src/prd/prdValidator";
import { evaluateMergePolicy, MergePolicyConfig, buildMergePolicyConfig } from "../src/prd/mergePolicy";
import { buildPrdSummary, buildPrdReportSection } from "../src/prd/prdReport";
import { reportPrdValidationToGitHub } from "../src/github/checkReporter";
import { ChangedFile } from "../src/github/prFetcher";
import { LLMClient } from "../src/llm/claudeClient";

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => console.log(`  ✅ PASS: ${name}`))
        .catch((err) => {
          console.error(`  ❌ FAIL: ${name}`);
          console.error(`     ${err.message}`);
          throw err;
        });
    }
    console.log(`  ✅ PASS: ${name}`);
  } catch (err: any) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    throw err;
  }
}

async function runAllTests() {
  console.log("\n🧪 Running Comprehensive PRD Validation & Merge Protection Test Suite...\n");

  // ───────────────────────────────────────────────────────────────────────────
  // Section 1: Connectors & Normalization
  // ───────────────────────────────────────────────────────────────────────────
  console.log("Section 1: Connectors & Requirement Normalization");

  await test("JiraConnector reports credentialsMissing when unconfigured", async () => {
    const connector = new JiraConnector();
    const result = await connector.fetch({});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.credentialsMissing, true);
    assert.strictEqual(result.requirements.length, 0);
    // Credentials should never be leaked
    assert.ok(!result.diagnostics.some(d => d.includes("secret") || d.includes("token")));
  });

  await test("ConfluenceConnector reports credentialsMissing when unconfigured", async () => {
    const connector = new ConfluenceConnector();
    const result = await connector.fetch({});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.credentialsMissing, true);
    assert.strictEqual(result.requirements.length, 0);
  });

  await test("ExternalDocConnector blocks SSRF to private IP ranges", async () => {
    const connector = new ExternalDocConnector();
    const localResult = await connector.fetch({
      externalDocUrls: ["http://127.0.0.1/secret", "http://169.254.169.254/latest/meta-data/"],
    });
    // Private IPs must be blocked by SSRF guards
    assert.strictEqual(localResult.requirements.length, 0);
    assert.ok(localResult.diagnostics.some(d => d.includes("blocked by SSRF guard") || d.includes("private")));
  });

  await test("ExternalDocConnector converts Google Docs URLs to export format", () => {
    const editUrl = "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing";
    const exportUrl = toGoogleDocsExportUrl(editUrl);
    assert.strictEqual(
      exportUrl,
      "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=txt"
    );

    const nonGdocs = "https://raw.githubusercontent.com/org/repo/main/docs/PRD.md";
    assert.strictEqual(toGoogleDocsExportUrl(nonGdocs), null);
  });

  await test("LocalRepoConnector extracts NormalizedRequirements from fixtures", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-local-prd-"));
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });

    fs.writeFileSync(
      path.join(docsDir, "PRD.md"),
      `# Order Checkout PRD (ORD-101)
## Summary
This document specifies the checkout requirement.
## Acceptance Criteria
- Must validate coupon codes before charging user
- Must calculate state sales tax accurately
- Verification: unit tests required for coupon expiry
`,
      "utf-8"
    );

    const connector = new LocalRepoConnector(tmpDir);
    const result = await connector.fetch({ repoPath: tmpDir });

    assert.strictEqual(result.success, true);
    assert.ok(result.requirements.length > 0, "Should have extracted requirements");

    const mandatoryReq = result.requirements.find(r => r.severity === "mandatory");
    assert.ok(mandatoryReq, "Should have at least one mandatory requirement");
    assert.ok(mandatoryReq.title.includes("Order Checkout"));
    assert.strictEqual(mandatoryReq.source, "local_file");
    assert.strictEqual(mandatoryReq.severity, "mandatory");
    assert.ok(mandatoryReq.acceptanceCriteria.length >= 1);
    assert.ok(mandatoryReq.traceability.length > 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Section 2: Requirement Mapping & Deterministic Checks
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nSection 2: Requirement Mapping & Deterministic Checks");

  const sampleReq: NormalizedRequirement = {
    id: "REQ-COUPON-1",
    source: "local_file",
    title: "Apply Coupon Code",
    description: "System must apply valid coupon code and discount the order subtotal.",
    acceptanceCriteria: [
      "Must reject expired coupons with HTTP 400",
      "Must verify coupon discount via unit tests",
    ],
    priority: "high",
    severity: "mandatory",
    sourceUrl: "docs/PRD.md",
    traceability: [],
    sourceKey: "PRD.md",
    contentExcerpt: "Must reject expired coupons",
  };

  await test("mapRequirementsToCode associates code and test files with requirements", () => {
    const changedFiles: ChangedFile[] = [
      {
        filename: "src/services/couponService.ts",
        status: "modified",
        additions: 15,
        deletions: 2,
        patch: "+ export function applyCoupon(code: string) { return code === 'SAVE20' ? 0.2 : 0; }",
      },
      {
        filename: "tests/coupon.test.ts",
        status: "added",
        additions: 30,
        deletions: 0,
        patch: "+ test('coupon discount', () => { assert.equal(applyCoupon('SAVE20'), 0.2); });",
      },
    ];

    const mappings = mapRequirementsToCode([sampleReq], changedFiles);
    assert.strictEqual(mappings.length, 1);
    assert.ok(mappings[0].affectedCodeFiles.includes("src/services/couponService.ts"));
    assert.ok(mappings[0].relatedTestFiles.includes("tests/coupon.test.ts"));
    assert.ok(mappings[0].relevanceScore > 0);
  });

  await test("runDeterministicChecks fails mandatory requirement when tests are required but missing", () => {
    const mappingWithoutTests: RequirementMapping = {
      requirement: sampleReq,
      affectedCodeFiles: ["src/services/couponService.ts"],
      relatedTestFiles: [], // missing tests!
      matchedKeywords: ["coupon"],
      relevanceScore: 0.8,
    };

    const checks = runDeterministicChecks([mappingWithoutTests]);
    assert.strictEqual(checks.length, 1);
    assert.strictEqual(checks[0].status, "FAIL");
    assert.ok(checks[0].missingFunctionality?.includes("Missing test coverage"));
  });

  await test("runDeterministicChecks marks unmatched mandatory requirement as INCONCLUSIVE", () => {
    const unmappedReq: RequirementMapping = {
      requirement: sampleReq,
      affectedCodeFiles: [],
      relatedTestFiles: [],
      matchedKeywords: [],
      relevanceScore: 0.0,
    };

    const checks = runDeterministicChecks([unmappedReq]);
    assert.strictEqual(checks.length, 1);
    assert.strictEqual(checks[0].status, "INCONCLUSIVE");
    assert.ok(checks[0].inconclusiveReason?.includes("No code in the PR diff matches"));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Section 3: Merge Policy Engine
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nSection 3: Merge Policy Engine");

  const mockConnectorResult = {
    allRequirements: [sampleReq],
    connectorResults: [],
    summary: "Mock connectors",
    hasCredentialGaps: false,
    hasUnreachableSources: false,
    allDiagnostics: [],
  };

  await test("evaluateMergePolicy blocks merge (FAIL) when a mandatory requirement fails", () => {
    const failResults: RequirementValidationResult[] = [
      {
        requirement: sampleReq,
        status: "FAIL",
        evidence: "Coupon expiry check was not implemented in checkout controller",
        codeLocations: ["src/services/couponService.ts"],
        missingFunctionality: "Missing coupon expiry check",
      },
    ];

    const policyConfig: MergePolicyConfig = {
      prdValidationEnabled: true,
      failOnInconclusive: true,
      failOnMissingCredentials: true,
      optionalPolicy: "warn",
    };

    const decision = evaluateMergePolicy(failResults, mockConnectorResult, policyConfig);
    assert.strictEqual(decision.result, "FAIL");
    assert.strictEqual(decision.failedMandatory.length, 1);
    assert.ok(decision.reason.includes("failed"));
  });

  await test("evaluateMergePolicy passes (PASS) when all mandatory requirements pass", () => {
    const passResults: RequirementValidationResult[] = [
      {
        requirement: sampleReq,
        status: "PASS",
        evidence: "Coupon verification implemented in couponService.ts:15 and verified in coupon.test.ts:20",
        codeLocations: ["src/services/couponService.ts:15", "tests/coupon.test.ts:20"],
      },
    ];

    const policyConfig: MergePolicyConfig = {
      prdValidationEnabled: true,
      failOnInconclusive: true,
      failOnMissingCredentials: true,
      optionalPolicy: "warn",
    };

    const decision = evaluateMergePolicy(passResults, mockConnectorResult, policyConfig);
    assert.strictEqual(decision.result, "PASS");
    assert.strictEqual(decision.failedMandatory.length, 0);
    assert.ok(decision.reason.includes("passed validation"));
  });

  await test("evaluateMergePolicy blocks merge on credential gap if failOnMissingCredentials is true", () => {
    const inconclusiveResults: RequirementValidationResult[] = [
      {
        requirement: sampleReq,
        status: "INCONCLUSIVE",
        evidence: "Jira ticket PROJ-101 could not be fetched due to missing JIRA_TOKEN",
        codeLocations: [],
        inconclusiveReason: "Credentials missing",
      },
    ];

    const resultWithGaps = {
      ...mockConnectorResult,
      hasCredentialGaps: true,
    };

    const policyConfig: MergePolicyConfig = {
      prdValidationEnabled: true,
      failOnInconclusive: true,
      failOnMissingCredentials: true,
      optionalPolicy: "warn",
    };

    const decision = evaluateMergePolicy(inconclusiveResults, resultWithGaps, policyConfig);
    assert.strictEqual(decision.result, "FAIL");
    assert.ok(decision.hasCredentialGaps);
    assert.ok(/inconclusive/i.test(decision.reason));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Section 4: PRD Report Builder & GitHub Check Reporter
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nSection 4: PRD Report Builder & GitHub Check Reporter");

  await test("buildPrdSummary generates structured Markdown with tables and status icons", () => {
    const passDecision = evaluateMergePolicy(
      [
        {
          requirement: sampleReq,
          status: "PASS",
          evidence: "Implemented and verified",
          codeLocations: ["src/services/couponService.ts:10"],
        },
      ],
      mockConnectorResult,
      {
        prdValidationEnabled: true,
        failOnInconclusive: true,
        failOnMissingCredentials: true,
        optionalPolicy: "warn",
      }
    );

    const summary = buildPrdSummary(passDecision, mockConnectorResult);
    assert.ok(summary.includes("## ✅ PRD Validation: PASS"));
    assert.ok(summary.includes("| Requirement | Source | Priority | Status | Evidence |"));
    assert.ok(summary.includes("REQ-COUPON-1"));
  });

  await test("reportPrdValidationToGitHub writes local markdown and json report files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-reports-"));
    const failDecision = evaluateMergePolicy(
      [
        {
          requirement: sampleReq,
          status: "FAIL",
          evidence: "Coupon verification missing",
          codeLocations: ["src/services/couponService.ts:10"],
          missingFunctionality: "Missing coupon expiry",
        },
      ],
      mockConnectorResult,
      {
        prdValidationEnabled: true,
        failOnInconclusive: true,
        failOnMissingCredentials: true,
        optionalPolicy: "warn",
      }
    );

    const res = await reportPrdValidationToGitHub(failDecision, mockConnectorResult, {
      owner: "vvkmj",
      repo: "myco-demo-api-service",
      headSha: "0000000000000000000000000000000000000000",
      outputDir: tmpDir,
    });

    assert.strictEqual(res.localReportsWritten, true);
    assert.ok(fs.existsSync(path.join(tmpDir, "prd-validation.md")));
    assert.ok(fs.existsSync(path.join(tmpDir, "prd-validation.json")));

    const json = JSON.parse(fs.readFileSync(path.join(tmpDir, "prd-validation.json"), "utf-8"));
    assert.strictEqual(json.decision, "FAIL");
    assert.strictEqual(json.failedMandatoryCount, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log("\n✨ All PRD Validation & Merge Protection tests completed successfully!\n");
}

runAllTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
