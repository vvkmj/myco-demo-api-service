import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  parseRepoMappings,
  parseRepoTokens,
  resolveMultiRepoDependencies,
} from "../src/multirepo/multiRepoResolver";
import {
  cloneExternalRepos,
  cleanupExternalRepos,
  ClonedExternalRepo,
} from "../src/multirepo/multiRepoCloner";
import {
  analyzeMultiRepoDependencies,
} from "../src/multirepo/multiRepoAnalyser";
import {
  buildMultiRepoContext,
  emptyMultiRepoContext,
  promoteXRepoFindings,
} from "../src/multirepo/multiRepoIntegration";
import { executeTool } from "../src/llm/claudeClient";
import { DiffContext } from "../src/github/prFetcher";

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
  console.log("\n🧪 Running Comprehensive Multi-Repository Test Suite...\n");

  // ── 1. Configuration Parsing ──────────────────────────────────────────────
  console.log("Section 1: Configuration Parsing");

  test("parseRepoMappings handles empty/undefined input", () => {
    assert.deepStrictEqual(parseRepoMappings(undefined), []);
    assert.deepStrictEqual(parseRepoMappings(""), []);
    assert.deepStrictEqual(parseRepoMappings("   "), []);
  });

  test("parseRepoMappings parses string mappings and object mappings", () => {
    const json = JSON.stringify({
      "@shared/types": "MyOrg/shared-types",
      "@shared/utils": { repo: "MyOrg/shared-utils", branch: "develop", token: "secret123" },
    });
    const result = parseRepoMappings(json);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].importPrefix, "@shared/types");
    assert.strictEqual(result[0].repoSlug, "MyOrg/shared-types");
    assert.strictEqual(result[1].importPrefix, "@shared/utils");
    assert.strictEqual(result[1].repoSlug, "MyOrg/shared-utils");
    assert.strictEqual(result[1].branch, "develop");
    assert.strictEqual(result[1].token, "secret123");
  });

  test("parseRepoMappings safely handles malformed JSON without crashing", () => {
    assert.deepStrictEqual(parseRepoMappings("{ malformed: json"), []);
  });

  test("parseRepoTokens parses token map and handles malformed JSON", () => {
    const json = JSON.stringify({ "MyOrg/repoA": "tokenA", "MyOrg/repoB": "tokenB" });
    const map = parseRepoTokens(json);
    assert.strictEqual(map.get("MyOrg/repoA"), "tokenA");
    assert.strictEqual(map.get("MyOrg/repoB"), "tokenB");
    assert.strictEqual(parseRepoTokens("invalid").size, 0);
  });

  // ── 2. Resolver & Import Extraction ───────────────────────────────────────
  console.log("\nSection 2: Dependency Resolution & Import Extraction");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-multirepo-test-"));
  const primaryRepoDir = path.join(tempDir, "primary-repo");
  fs.mkdirSync(primaryRepoDir, { recursive: true });

  // Create primary package.json with a git dependency
  fs.writeFileSync(
    path.join(primaryRepoDir, "package.json"),
    JSON.stringify({
      name: "primary-app",
      dependencies: {
        "@external/autolib": "github:AutoOrg/autolib",
        "lodash": "^4.17.21",
      },
    })
  );

  // Create a changed source file that imports from mapped, auto-detected, and local paths
  const srcFile = path.join(primaryRepoDir, "app.ts");
  fs.writeFileSync(
    srcFile,
    `
    import { UserContract, createSession } from "@shared/contracts";
    import AutoClient from "@external/autolib";
    import * as path from "path";
    import { map } from "lodash";
    import { localHelper } from "./helpers";
    `
  );

  const mockDiff: DiffContext = {
    sourceType: "pr",
    owner: "MyOrg",
    repo: "primary-app",
    prNumber: 42,
    slug: "pr-42",
    title: "Add cross-repo integration",
    description: "Connect with shared contracts and autolib",
    author: "engineer",
    baseRef: "main",
    headRef: "feature/cross-repo",
    labels: [],
    reviewers: [],
    diffSummary: "1 file changed",
    commits: [],
    changedFiles: [
      {
        filename: "app.ts",
        status: "modified",
        additions: 10,
        deletions: 2,
        patch: `@@ -1,2 +1,6 @@\n-export const oldLegacy = 1;\n+import { UserContract, createSession } from "@shared/contracts";\n+import AutoClient from "@external/autolib";`,
      },
    ],
  };

  test("resolveMultiRepoDependencies extracts and maps imports correctly", () => {
    const mappings = parseRepoMappings(
      JSON.stringify({ "@shared/contracts": "MyOrg/shared-contracts" })
    );
    const tokens = new Map<string, string>();

    const resolution = resolveMultiRepoDependencies(mockDiff, primaryRepoDir, mappings, tokens, true);
    assert.strictEqual(resolution.hasCrossRepoDeps, true);
    assert.strictEqual(resolution.dependencies.length, 2);

    const explicitDep = resolution.dependencies.find((d) => d.repoSlug === "MyOrg/shared-contracts");
    assert.ok(explicitDep);
    assert.strictEqual(explicitDep?.detectionMethod, "explicit-mapping");
    assert.deepStrictEqual(explicitDep?.importedSymbols, ["UserContract", "createSession"]);

    const autoDep = resolution.dependencies.find((d) => d.repoSlug === "AutoOrg/autolib");
    assert.ok(autoDep);
    assert.strictEqual(autoDep?.detectionMethod, "auto-detect");
    assert.deepStrictEqual(autoDep?.importedSymbols, ["AutoClient"]);
  });

  // ── 3. Cloner Security & Argument Injection ──────────────────────────────
  console.log("\nSection 3: Cloner Security & Path Traversal Guards");

  test("cloneExternalRepos rejects path traversal and flag injection", () => {
    const maliciousDeps = [
      {
        repoSlug: "../../etc/passwd",
        repoUrl: "https://github.com/../../etc/passwd",
        branch: "main",
        importSpecifiers: ["evil"],
        importedSymbols: [],
        referencingFiles: [],
        detectionMethod: "explicit-mapping" as const,
      },
      {
        repoSlug: "MyOrg/safe-repo",
        repoUrl: "https://github.com/MyOrg/safe-repo",
        branch: "--upload-pack=/evil/script",
        importSpecifiers: ["evil2"],
        importedSymbols: [],
        referencingFiles: [],
        detectionMethod: "explicit-mapping" as const,
      },
      {
        repoSlug: "MyOrg/..",
        repoUrl: "https://github.com/MyOrg/..",
        branch: "main",
        importSpecifiers: ["evil3"],
        importedSymbols: [],
        referencingFiles: [],
        detectionMethod: "explicit-mapping" as const,
      },
    ];

    const results = cloneExternalRepos(maliciousDeps, path.join(tempDir, "clones"));
    assert.strictEqual(results.length, 3);
    for (const res of results) {
      assert.strictEqual(res.success, false);
      assert.ok(res.error?.includes("Unsafe or malformed repo slug/branch"));
    }
  });

  // ── 4. Cross-Repo Analysis & Verification ────────────────────────────────
  console.log("\nSection 4: Cross-Repo Analysis & Contract Verification");

  // Create a mock external repository on disk
  const externalRepoDir = path.join(tempDir, "clones", "MyOrg", "shared-contracts");
  fs.mkdirSync(path.join(externalRepoDir, "src"), { recursive: true });

  // Export UserContract, but deliberately OMIT createSession
  fs.writeFileSync(
    path.join(externalRepoDir, "src", "index.ts"),
    `
    export interface UserContract {
      id: string;
      email: string;
    }
    export const version = "1.0.0";
    `
  );

  const clonedRepos: ClonedExternalRepo[] = [
    {
      repoSlug: "MyOrg/shared-contracts",
      localPath: externalRepoDir,
      branch: "main",
      dependency: {
        repoSlug: "MyOrg/shared-contracts",
        repoUrl: "https://github.com/MyOrg/shared-contracts",
        branch: "main",
        importSpecifiers: ["@shared/contracts"],
        importedSymbols: ["UserContract", "createSession"],
        referencingFiles: ["app.ts"],
        detectionMethod: "explicit-mapping",
      },
      success: true,
    },
  ];

  test("analyzeMultiRepoDependencies verifies valid symbols and flags missing symbols", () => {
    const analysis = analyzeMultiRepoDependencies(clonedRepos, primaryRepoDir, mockDiff);
    assert.strictEqual(analysis.results.length, 1);
    const res = analysis.results[0];

    assert.deepStrictEqual(res.verifiedImports, ["UserContract"]);
    assert.deepStrictEqual(res.brokenImports, ["createSession"]);
    assert.strictEqual(res.findings.length, 1);

    const finding = res.findings[0];
    assert.ok(finding.id.startsWith("P1-XREPO-"));
    assert.ok(finding.title.includes('createSession" not found'));
    assert.strictEqual(finding.filePath, "app.ts");
    assert.strictEqual(finding.line, 2); // line 2 of app.ts
  });

  // ── 5. Breaking Change Detection ("And Vice Versa") ──────────────────────
  console.log("\nSection 5: Breaking Change Detection in Consumed Exports (Vice Versa)");

  // Add an export in the external repo that consumes something from primaryRepoDir
  // Primary repo exports `paymentService`
  fs.writeFileSync(
    path.join(primaryRepoDir, "service.ts"),
    `export const paymentService = { charge: () => {} };`
  );

  // External repo references paymentService
  fs.writeFileSync(
    path.join(externalRepoDir, "src", "client.ts"),
    `import { paymentService } from "@myorg/primary-app";\npaymentService.charge();`
  );

  // PR diff that DELETES paymentService
  const breakingDiff: DiffContext = {
    ...mockDiff,
    changedFiles: [
      {
        filename: "service.ts",
        status: "modified",
        additions: 0,
        deletions: 1,
        patch: `@@ -1,1 +0,0 @@\n-export const paymentService = { charge: () => {} };`,
      },
    ],
  };

  test("analyzeMultiRepoDependencies catches downstream breaking change when PR deletes consumed export", () => {
    // Empty the file so paymentService is removed from primary export index
    fs.writeFileSync(path.join(primaryRepoDir, "service.ts"), `// paymentService removed`);

    const analysis = analyzeMultiRepoDependencies(clonedRepos, primaryRepoDir, breakingDiff);
    const breakingFinding = analysis.findings.find((f) =>
      f.title.includes('Breaking change: export "paymentService"')
    );

    assert.ok(breakingFinding, "Should generate a breaking change finding for paymentService");
    assert.strictEqual(breakingFinding?.filePath, "service.ts");
    assert.ok(breakingFinding?.rootCause.includes("actively consumed by external repository MyOrg/shared-contracts"));
  });

  // ── 6. Promotion & Integration ───────────────────────────────────────────
  console.log("\nSection 6: Integration Context & Finding Promotion");

  test("promoteXRepoFindings elevates static cross-repo findings to CONFIRMED merge-blockers", () => {
    const analysis = analyzeMultiRepoDependencies(clonedRepos, primaryRepoDir, mockDiff);
    const promoted = promoteXRepoFindings(analysis.findings);

    assert.strictEqual(promoted.length, analysis.findings.length);
    for (const p of promoted) {
      assert.strictEqual(p.verdict, "CONFIRMED");
      assert.strictEqual(p.mergeBlocking, true);
      assert.strictEqual(p.confidence, "HIGH");
      assert.ok(p.hash && p.hash.length === 8);
      assert.ok(p.validatorReasoning.includes("Cross-repo static analysis"));
    }
  });

  test("buildMultiRepoContext creates complete bundle and maps import specifiers", () => {
    const resolution = resolveMultiRepoDependencies(
      mockDiff,
      primaryRepoDir,
      parseRepoMappings(JSON.stringify({ "@shared/contracts": "MyOrg/shared-contracts" })),
      new Map(),
      false
    );
    const analysis = analyzeMultiRepoDependencies(clonedRepos, primaryRepoDir, mockDiff);
    const bundle = buildMultiRepoContext(resolution, clonedRepos, analysis);

    assert.strictEqual(bundle.enabled, true);
    assert.ok(bundle.reviewContext.includes("Cross-Repository Context"));
    assert.ok(bundle.validatorContext.includes("Cross-Repository Verification Context"));
    assert.ok(bundle.analysisSummary.includes("Cross-Repository Analysis Summary"));
    assert.ok(bundle.repoPathMap.has("MyOrg/shared-contracts"));
    assert.ok(bundle.repoPathMap.has("@shared/contracts"));
  });

  test("emptyMultiRepoContext returns clean disabled state", () => {
    const empty = emptyMultiRepoContext();
    assert.strictEqual(empty.enabled, false);
    assert.strictEqual(empty.reviewContext, "");
    assert.strictEqual(empty.staticFindings.length, 0);
    assert.strictEqual(empty.repoPathMap.size, 0);
  });

  // ── 7. Tool Execution (read_file) Multi-Repo Support ───────────────────────
  console.log("\nSection 7: Tool Execution (read_file) with repoPathMap");

  test("executeTool reads files from external repo using slug or import prefix", () => {
    const repoPathMap = new Map<string, string>();
    repoPathMap.set("MyOrg/shared-contracts", externalRepoDir);
    repoPathMap.set("@shared/contracts", externalRepoDir);

    // Read via repo slug
    const viaSlug = executeTool(
      "read_file",
      { path: "MyOrg/shared-contracts/src/index.ts" },
      primaryRepoDir,
      repoPathMap
    );
    assert.ok(viaSlug.includes("UserContract"));

    // Read via import prefix
    const viaPrefix = executeTool(
      "read_file",
      { path: "@shared/contracts/src/index.ts" },
      primaryRepoDir,
      repoPathMap
    );
    assert.ok(viaPrefix.includes("UserContract"));

    // Path traversal outside external repo is prevented
    const traversal = executeTool(
      "read_file",
      { path: "@shared/contracts/../../../../etc/passwd" },
      primaryRepoDir,
      repoPathMap
    );
    assert.ok(traversal.includes("Error:"));
  });

  // ── 8. Cleanup ───────────────────────────────────────────────────────────
  console.log("\nSection 8: Fail-Safe Cleanup Hook");

  test("cleanupExternalRepos safely deletes cloned directories and prunes empty parents", () => {
    assert.strictEqual(fs.existsSync(externalRepoDir), true);
    cleanupExternalRepos(clonedRepos);
    assert.strictEqual(fs.existsSync(externalRepoDir), false);
  });

  // Teardown temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  console.log("\n✨ All tests completed successfully!\n");
}

runTests();
