import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  extractJiraKeys,
  parseRequirementFile,
  scanFolderRequirements,
} from "../src/requirements/requirementScanner";
import {
  analyzeRequirementChanges,
  isRequirementFile,
  isCodeFile,
} from "../src/requirements/requirementChangeTracker";
import {
  buildRequirementContext,
  emptyRequirementContext,
} from "../src/requirements/requirementIntegration";
import {
  isLocalFolder,
  parseRawGitDiff,
  readLocalFolderDiff,
} from "../src/repo/localFolderReader";
import { ChangedFile } from "../src/github/prFetcher";

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        () => console.log(`  ✅ PASS: ${name}`),
        (err) => {
          console.error(`  ❌ FAIL: ${name}`);
          console.error(err);
          process.exitCode = 1;
        }
      );
    }
    console.log(`  ✅ PASS: ${name}`);
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function runTests() {
  console.log("\n🧪 Running Comprehensive Requirements Intelligence Test Suite...\n");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-req-test-"));

  try {
    // ── 1. Jira Key Extraction ──────────────────────────────────────────────
    console.log("Section 1: Jira Key Extraction");

    test("extractJiraKeys extracts keys from diverse formats", () => {
      const text = "feat(auth): [PROJ-1234] add OAuth login\nFixes PROJ-1234 and relates to CORE-99\n[JIRA-42]";
      const keys = extractJiraKeys(text);
      assert.deepStrictEqual(keys.sort(), ["CORE-99", "JIRA-42", "PROJ-1234"]);
    });

    test("extractJiraKeys returns empty array on empty or non-matching text", () => {
      assert.deepStrictEqual(extractJiraKeys(""), []);
      assert.deepStrictEqual(extractJiraKeys("just a normal commit message without tickets"), []);
    });

    // ── 2. Requirement File & Folder Scanner ────────────────────────────────
    console.log("\nSection 2: Requirement Document & Jira Parsing");

    // Create test folder structure in tempDir
    const docsDir = path.join(tempDir, "docs");
    const jiraDir = path.join(tempDir, ".jira");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(jiraDir, { recursive: true });

    // Write a markdown spec
    const specPath = path.join(docsDir, "payment-spec.md");
    fs.writeFileSync(
      specPath,
      `# Payment Gateway Integration Spec
This document describes the requirements for integrating Stripe checkout.

## Acceptance Criteria
- [ ] AC1: All payment requests must validate currency code against ISO-4217
- [ ] AC2: Reject any transaction exceeding $10,000 without 2FA
- [x] AC3: Idempotency key must be passed in Stripe-Idempotency header

## Constraints
All timeouts must be set to 5000ms.
`,
      "utf-8"
    );

    // Write a Jira Markdown ticket
    const jiraMdPath = path.join(jiraDir, "PROJ-101.md");
    fs.writeFileSync(
      jiraMdPath,
      `# PROJ-101: Auto-refund failed charges
Type: Story
Status: Ready for Dev
Priority: High

### Description
When a webhook reports charge.failed, auto-issue a credit memo.

### Acceptance Criteria
- [ ] Webhook signature must be verified using HMAC-SHA256
- [ ] Credit memo must be created with matching transactionId
`,
      "utf-8"
    );

    // Write a Jira JSON export
    const jiraJsonPath = path.join(jiraDir, "PROJ-202.json");
    fs.writeFileSync(
      jiraJsonPath,
      JSON.stringify({
        key: "PROJ-202",
        fields: {
          summary: "Rate limiting for public API",
          description: "Limit unauthenticated calls to 60 requests per minute.",
          issuetype: { name: "Security" },
          status: { name: "In Progress" },
        },
        acceptanceCriteria: [
          "Return 429 Too Many Requests when rate limit exceeded",
          "Include Retry-After header with seconds remaining",
        ],
      }),
      "utf-8"
    );

    test("parseRequirementFile parses markdown spec with acceptance criteria", () => {
      const doc = parseRequirementFile(specPath, "docs/payment-spec.md");
      assert.ok(doc !== null);
      assert.strictEqual(doc?.title, "Payment Gateway Integration Spec");
      assert.strictEqual(doc?.docType, "markdown_doc");
      assert.strictEqual(doc?.requirements.length, 2);
      const acList = doc?.requirements.flatMap((r) => r.acceptanceCriteria || []);
      assert.strictEqual(acList?.length, 3);
      assert.ok(acList?.some((ac) => ac.includes("ISO-4217")));
      assert.ok(acList?.some((ac) => ac.includes("2FA")));
    });

    test("parseRequirementFile parses Jira markdown ticket", () => {
      const doc = parseRequirementFile(jiraMdPath, ".jira/PROJ-101.md");
      assert.ok(doc !== null);
      assert.strictEqual(doc?.docType, "jira_ticket");
      assert.strictEqual(doc?.jiraTickets?.length, 1);
      assert.strictEqual(doc?.jiraTickets?.[0].key, "PROJ-101");
      assert.strictEqual(doc?.jiraTickets?.[0].acceptanceCriteria.length, 2);
      assert.ok(doc?.jiraTickets?.[0].acceptanceCriteria[0].includes("HMAC-SHA256"));
    });

    test("parseRequirementFile parses Jira JSON export", () => {
      const doc = parseRequirementFile(jiraJsonPath, ".jira/PROJ-202.json");
      assert.ok(doc !== null);
      assert.strictEqual(doc?.docType, "jira_export");
      assert.strictEqual(doc?.jiraTickets?.length, 1);
      assert.strictEqual(doc?.jiraTickets?.[0].key, "PROJ-202");
      assert.strictEqual(doc?.jiraTickets?.[0].summary, "Rate limiting for public API");
      assert.strictEqual(doc?.jiraTickets?.[0].acceptanceCriteria.length, 2);
      assert.ok(doc?.jiraTickets?.[0].acceptanceCriteria[0].includes("429 Too Many Requests"));
    });

    test("scanFolderRequirements scans and prioritizes documents matching PR tickets", () => {
      const scan = scanFolderRequirements(tempDir, [], "PR #42: [PROJ-202] Add rate limiting middleware");
      assert.strictEqual(scan.documents.length, 3);
      // PROJ-202 should be prioritized first because PR mentions PROJ-202
      assert.strictEqual(scan.documents[0].jiraTickets?.[0].key, "PROJ-202");
      assert.strictEqual(scan.jiraTickets.length, 2);
      assert.ok(scan.allRequirements.length >= 3);
    });

    // ── 3. Requirement Change Tracking ──────────────────────────────────────
    console.log("\nSection 3: Requirement Change Tracking & Delta Analysis");

    test("isRequirementFile correctly identifies requirement files", () => {
      assert.strictEqual(isRequirementFile("docs/auth.md", []), true);
      assert.strictEqual(isRequirementFile("specs/api.yaml", []), true);
      assert.strictEqual(isRequirementFile(".jira/PROJ-12.json", []), true);
      assert.strictEqual(isRequirementFile("src/services/auth.ts", []), false);
    });

    test("isCodeFile correctly separates code from test files", () => {
      assert.strictEqual(isCodeFile("src/services/payment.ts"), true);
      assert.strictEqual(isCodeFile("src/controllers/user.java"), true);
      assert.strictEqual(isCodeFile("src/services/payment.test.ts"), false);
      assert.strictEqual(isCodeFile("src/test/java/UserTest.java"), false);
    });

    test("analyzeRequirementChanges detects requirement delta and code correlation", () => {
      const changedFiles: ChangedFile[] = [
        {
          filename: "docs/payment-spec.md",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: `@@ -5,3 +5,4 @@
- Reject any transaction exceeding $10,000 without 2FA
+ Reject any transaction exceeding $5,000 without 2FA
+ Add SMS notification for all transactions above $1,000
`,
        },
        {
          filename: "src/services/paymentService.ts",
          status: "modified",
          additions: 10,
          deletions: 2,
          patch: `@@ -40,2 +40,10 @@
+ if (amount > 10000 && !user.has2FA) throw new Error("2FA required");
`,
        },
      ];

      const analysis = analyzeRequirementChanges(changedFiles, []);
      assert.strictEqual(analysis.hasRequirementChanges, true);
      assert.strictEqual(analysis.modifiedRequirementFiles.length, 1);
      assert.strictEqual(analysis.codeFilesTouched.length, 1);
      assert.ok(analysis.addedRequirements.some((a) => a.includes("$5,000 without 2FA")));
      assert.ok(analysis.removedRequirements.some((r) => r.includes("$10,000 without 2FA")));
      assert.ok(analysis.summary.includes("Requirement Changes Detected in Diff"));
      assert.ok(analysis.summary.includes("CRITICAL VERIFICATION REQUIRED"));
    });

    test("analyzeRequirementChanges flags scope check when only code changed", () => {
      const changedFiles: ChangedFile[] = [
        {
          filename: "src/controllers/auth.ts",
          status: "modified",
          additions: 15,
          deletions: 0,
        },
      ];

      const scannedDocs = [
        {
          filePath: "docs/auth.md",
          fileName: "auth.md",
          docType: "markdown_doc" as const,
          title: "Auth Spec",
          rawContent: "Specs",
          summary: "Summary",
          requirements: [],
        },
      ];

      const analysis = analyzeRequirementChanges(changedFiles, scannedDocs);
      assert.strictEqual(analysis.hasRequirementChanges, false);
      assert.strictEqual(analysis.codeFilesTouched.length, 1);
      assert.ok(analysis.summary.includes("Existing Requirements Active"));
      assert.ok(analysis.summary.includes("Unnecessary change / Scope creep"));
    });

    // ── 4. Requirement Integration & Prompt Generation ──────────────────────
    console.log("\nSection 4: Requirement Integration Context");

    test("buildRequirementContext generates prompt and validator context", () => {
      const changedFiles: ChangedFile[] = [
        {
          filename: "src/services/payment.ts",
          status: "modified",
          additions: 5,
          deletions: 1,
        },
      ];

      const reqCtx = buildRequirementContext(tempDir, changedFiles, "Implement rate limiting");
      assert.strictEqual(reqCtx.enabled, true);
      assert.ok(reqCtx.promptContext.includes("## Documented Requirements & Jira Context"));
      assert.ok(reqCtx.promptContext.includes("Payment Gateway Integration Spec"));
      assert.ok(reqCtx.promptContext.includes("SDET Requirement Verification Mandate"));
      assert.ok(reqCtx.promptContext.includes("Requirement Failure / Non-compliance"));
      assert.ok(reqCtx.promptContext.includes("Unnecessary Changes / Scope Creep"));
      assert.ok(reqCtx.validatorContext.includes("## Ground Truth Requirements Context"));
    });

    test("emptyRequirementContext returns clean disabled state", () => {
      const empty = emptyRequirementContext();
      assert.strictEqual(empty.enabled, false);
      assert.strictEqual(empty.documents.length, 0);
      assert.strictEqual(empty.promptContext, "");
      assert.strictEqual(empty.validatorContext, "");
    });

    // ── 5. Local Folder Reader ──────────────────────────────────────────────
    console.log("\nSection 5: Local Folder Diff Reader");

    test("isLocalFolder correctly detects local directories", () => {
      assert.strictEqual(isLocalFolder(tempDir), true);
      assert.strictEqual(isLocalFolder(`file://${tempDir}`), true);
      assert.strictEqual(isLocalFolder("./src"), true);
      assert.strictEqual(isLocalFolder("https://github.com/org/repo/pull/1"), false);
      assert.strictEqual(isLocalFolder("non-existent-folder-12345"), false);
    });

    test("parseRawGitDiff parses unified diff into ChangedFile[] with patches", () => {
      const rawGitDiff = `diff --git a/src/app.ts b/src/app.ts
index 123456..789abc 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
diff --git a/docs/spec.md b/docs/spec.md
new file mode 100644
index 000000..def456
--- /dev/null
+++ b/docs/spec.md
@@ -0,0 +1,2 @@
+# New Spec
+All good.
`;
      const files = parseRawGitDiff(rawGitDiff);
      assert.strictEqual(files.length, 2);
      assert.strictEqual(files[0].filename, "src/app.ts");
      assert.strictEqual(files[0].status, "modified");
      assert.strictEqual(files[0].additions, 1);
      assert.strictEqual(files[0].deletions, 0);
      assert.ok(files[0].patch?.includes("+const y = 2;"));

      assert.strictEqual(files[1].filename, "docs/spec.md");
      assert.strictEqual(files[1].status, "added");
      assert.strictEqual(files[1].additions, 2);
    });

    test("readLocalFolderDiff reads changes and creates DiffContext", async () => {
      const diff = await readLocalFolderDiff(tempDir);
      assert.strictEqual(diff.sourceType, "local");
      assert.ok(diff.repo.length > 0);
      assert.ok(diff.changedFiles.length > 0);
      assert.ok(diff.diffSummary.length > 0);
      assert.ok(diff.slug.startsWith("local_"));
    });

    console.log("\n✨ All Requirements Intelligence tests completed successfully!");
  } finally {
    // Clean up temporary test files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runTests();
