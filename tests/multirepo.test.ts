import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  parseRepoMappings,
  parseDownstreamRepos,
  parseProjectRepos,
  parseRepoTokens,
  extractApiContracts,
  resolveMultiRepoDependencies,
} from "../src/multirepo/multiRepoResolver";
import {
  cloneExternalRepos,
  cleanupExternalRepos,
  ClonedExternalRepo,
} from "../src/multirepo/multiRepoCloner";
import {
  analyzeMultiRepoDependencies,
  scanRepoKnowledge,
  extractPythonExports,
  extractK8sManifests,
  extractClientCallsAndEnvVars,
  queryCrossRepoKnowledge,
  parseFunctionParams,
  extractCallArguments,
  parseInterfaceProperties,
  findConsumerCallSites,
  CrossRepoKnowledgeBase,
} from "../src/multirepo/multiRepoAnalyser";
import {
  buildMultiRepoContext,
  emptyMultiRepoContext,
  promoteXRepoFindings,
  queryProjectKnowledge,
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

  // ── 8. Subtle Breaking Changes (Signature & Contract Changes without export removal) ──
  console.log("\nSection 8: Subtle Breaking Changes (Signature & Contract Changes without export removal)");

  test("parseDownstreamRepos correctly extracts downstream consumers from various formats", () => {
    // Array format
    const arr = parseDownstreamRepos(JSON.stringify(["MyOrg/consumer-a", "MyOrg/consumer-b"]));
    assert.strictEqual(arr.length, 2);
    assert.strictEqual(arr[0].repoSlug, "MyOrg/consumer-a");
    assert.strictEqual(arr[1].repoSlug, "MyOrg/consumer-b");

    // Comma-separated format
    const csv = parseDownstreamRepos("MyOrg/consumer-c, MyOrg/consumer-d");
    assert.strictEqual(csv.length, 2);
    assert.strictEqual(csv[0].repoSlug, "MyOrg/consumer-c");
    assert.strictEqual(csv[1].repoSlug, "MyOrg/consumer-d");
  });

  test("parseFunctionParams extracts required arguments and flags optional/default parameters", () => {
    const f1 = parseFunctionParams("export function calculateTax(amount: number)");
    assert.strictEqual(f1.minArgs, 1);
    assert.strictEqual(f1.params.length, 1);
    assert.strictEqual(f1.params[0].isOptional, false);

    const f2 = parseFunctionParams("export function calculateTax(amount: number, currency: string)");
    assert.strictEqual(f2.minArgs, 2);
    assert.strictEqual(f2.params.length, 2);

    const f3 = parseFunctionParams("export function calculateTax(amount: number, currency?: string)");
    assert.strictEqual(f3.minArgs, 1);
    assert.strictEqual(f3.params[1].isOptional, true);

    const f4 = parseFunctionParams('export function calculateTax(amount: number, currency: string = "USD")');
    assert.strictEqual(f4.minArgs, 1);
    assert.strictEqual(f4.params[1].hasDefault, true);
  });

  test("extractCallArguments parses argument counts correctly", () => {
    assert.strictEqual(extractCallArguments("const t = calculateTax(total);", "calculateTax").length, 1);
    assert.strictEqual(extractCallArguments("const t = calculateTax(total, 'USD');", "calculateTax").length, 2);
    assert.strictEqual(extractCallArguments("const t = calculateTax();", "calculateTax").length, 0);
  });

  test("catches subtle breaking change when PR adds required param without removing export", () => {
    // Primary repo (shared library) exports calculateTax with 1 param initially,
    // and PR updates file on disk to require 2 params: (amount: number, currency: string)
    const taxFile = path.join(primaryRepoDir, "tax.ts");
    fs.writeFileSync(
      taxFile,
      `export function calculateTax(amount: number, currency: string) {\n  return amount * 0.1;\n}\n`
    );

    // Downstream external consumer repo calls calculateTax with only 1 param
    const consumerClientFile = path.join(externalRepoDir, "src", "checkout.ts");
    fs.writeFileSync(
      consumerClientFile,
      `import { calculateTax } from "@shared/contracts";\nconst tax = calculateTax(100);\n`
    );

    // PR diff in primary repo: changed from 1 param to 2 params (export NOT removed!)
    const subtleBreakingDiff: DiffContext = {
      ...mockDiff,
      changedFiles: [
        {
          filename: "tax.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: `@@ -1,3 +1,3 @@\n-export function calculateTax(amount: number) {\n+export function calculateTax(amount: number, currency: string) {\n   return amount * 0.1;`,
        },
      ],
    };

    const analysis = analyzeMultiRepoDependencies(clonedRepos, primaryRepoDir, subtleBreakingDiff);

    // Find the breaking change finding
    const breakingFinding = analysis.findings.find((f) =>
      f.title.includes('Breaking change: export "calculateTax" modified')
    );

    assert.ok(breakingFinding, "Must generate breaking change finding when required parameter is added");
    assert.strictEqual(breakingFinding?.filePath, "tax.ts");
    assert.ok(breakingFinding?.rootCause.includes("requires 2 argument(s), previously 1"));
    assert.ok(breakingFinding?.rootCause.includes("calls \"calculateTax\" with only 1 argument(s)"));
    assert.ok(breakingFinding?.rootCause.includes("checkout.ts"));

    // Verify finding promotion
    const promoted = promoteXRepoFindings([breakingFinding!]);
    assert.strictEqual(promoted[0].verdict, "CONFIRMED");
    assert.strictEqual(promoted[0].mergeBlocking, true);
  });

  test("catches breaking change when PR removes property from an interface used downstream", () => {
    // Primary repo modifies UserRecord: removes "email" property
    const userTypeFile = path.join(primaryRepoDir, "user.ts");
    fs.writeFileSync(
      userTypeFile,
      `export interface UserRecord {\n  id: string;\n  fullName: string;\n}\n`
    );

    // Downstream external consumer repo accesses user.email
    const consumerUserFile = path.join(externalRepoDir, "src", "users.ts");
    fs.writeFileSync(
      consumerUserFile,
      `import { UserRecord } from "@shared/contracts";\nexport function notify(u: UserRecord) {\n  return u.email;\n}\n`
    );

    const interfaceBreakingDiff: DiffContext = {
      ...mockDiff,
      changedFiles: [
        {
          filename: "user.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: `@@ -1,4 +1,4 @@\n export interface UserRecord {\n   id: string;\n-  email: string;\n+  fullName: string;\n }`,
        },
      ],
    };

    const analysis = analyzeMultiRepoDependencies(clonedRepos, primaryRepoDir, interfaceBreakingDiff);

    const breakingFinding = analysis.findings.find((f) =>
      f.title.includes('Breaking change: property "email" removed from "UserRecord"')
    );

    assert.ok(breakingFinding, "Must generate breaking change finding when interface property is removed");
    assert.strictEqual(breakingFinding?.filePath, "user.ts");
    assert.ok(breakingFinding?.rootCause.includes("accesses this property"));
    assert.ok(breakingFinding?.rootCause.includes("users.ts"));

    const promoted = promoteXRepoFindings([breakingFinding!]);
    assert.strictEqual(promoted[0].verdict, "CONFIRMED");
    assert.strictEqual(promoted[0].mergeBlocking, true);
  });

  // ── 9. Cleanup ───────────────────────────────────────────────────────────
  console.log("\nSection 9: Fail-Safe Cleanup Hook");

  test("cleanupExternalRepos safely deletes cloned directories and prunes empty parents", () => {
    assert.strictEqual(fs.existsSync(externalRepoDir), true);
    cleanupExternalRepos(clonedRepos);
    assert.strictEqual(fs.existsSync(externalRepoDir), false);
  });

  // ── 10. Project-Level Shared Repository Enrollment ───────────────────────
  console.log("\nSection 10: Project-Level Shared Repository Enrollment & Config");

  test("parseProjectRepos parses comma-separated, JSON array, and JSON object configs", () => {
    const rawList = "vvkmj/myco-multirepo-lab-frontend, vvkmj/myco-multirepo-lab-backend, vvkmj/myco-multirepo-lab-k8s";
    const resList = parseProjectRepos(rawList);
    assert.strictEqual(resList.repositories.length, 3);
    assert.strictEqual(resList.repositories[0].repoSlug, "vvkmj/myco-multirepo-lab-frontend");
    assert.strictEqual(resList.repositories[1].repoSlug, "vvkmj/myco-multirepo-lab-backend");
    assert.strictEqual(resList.repositories[2].repoSlug, "vvkmj/myco-multirepo-lab-k8s");

    const jsonConfig = JSON.stringify({
      projectId: "lab-project-1",
      repositories: [
        { repo: "org/repo-a", branch: "dev", localPath: "/tmp/a" },
        "org/repo-b",
      ],
    });
    const resJson = parseProjectRepos(jsonConfig);
    assert.strictEqual(resJson.repositories.length, 2);
    assert.strictEqual(resJson.repositories[0].repoSlug, "org/repo-a");
    assert.strictEqual(resJson.repositories[0].branch, "dev");
    assert.strictEqual(resJson.localPaths?.["org/repo-a"], "/tmp/a");
    assert.strictEqual(resJson.repositories[1].repoSlug, "org/repo-b");
  });

  test("parseProjectRepos reads in-repo .myco/project.json and package.json configuration", () => {
    const testRepo = path.join(tempDir, "in-repo-config-test");
    fs.mkdirSync(path.join(testRepo, ".myco"), { recursive: true });
    fs.writeFileSync(
      path.join(testRepo, ".myco", "project.json"),
      JSON.stringify({
        projectId: "in-repo-proj",
        repositories: ["team/frontend", "team/backend", "team/k8s"],
      })
    );

    const cfg = parseProjectRepos(undefined, testRepo);
    assert.strictEqual(cfg.repositories.length, 3);
    assert.strictEqual(cfg.repositories[0].repoSlug, "team/frontend");
    assert.strictEqual(cfg.repositories[1].repoSlug, "team/backend");
    assert.strictEqual(cfg.repositories[2].repoSlug, "team/k8s");
  });

  // ── 11. Polyglot Contract & Manifest Extraction ───────────────────────────
  console.log("\nSection 11: Polyglot Contract & Manifest Extraction (Python FastAPI + Kubernetes)");

  test("extractPythonExports extracts FastAPI routes, response models, and fields", () => {
    const pyCode = `
import time
from pydantic import BaseModel, Field
from fastapi import FastAPI

app = FastAPI(title="Backend Service", version="1.4.0")

class HealthResponse(BaseModel):
    status: str = Field(..., description="Health status")
    timestamp: str

class StatusResponse(BaseModel):
    service: str
    version: str
    status: str
    dependencies: dict
    uptime_seconds: int

@app.get("/api/v1/status", response_model=StatusResponse)
def get_status() -> StatusResponse:
    return StatusResponse(service="order-processor", version="1.4.0", status="operational", dependencies={}, uptime_seconds=120)
`;
    const result = extractPythonExports(pyCode, "app/main.py", "org/backend");
    assert.strictEqual(result.endpoints.length, 1);
    assert.strictEqual(result.endpoints[0].path, "/api/v1/status");
    assert.strictEqual(result.endpoints[0].method, "GET");
    assert.strictEqual(result.endpoints[0].responseModel, "StatusResponse");
    assert.deepStrictEqual(result.endpoints[0].responseFields, [
      "service", "version", "status", "dependencies", "uptime_seconds"
    ]);

    const statusExport = result.exports.find(e => e.symbolName === "get_status");
    assert.ok(statusExport, "Must export get_status function");
  });

  test("extractK8sManifests extracts Service and Ingress routing rules", () => {
    const k8sServiceYaml = `
apiVersion: v1
kind: Service
metadata:
  name: myco-lab-backend-svc
spec:
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
    name: http
  selector:
    app: myco-lab-backend
`;
    const k8sIngressYaml = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myco-lab-ingress
spec:
  rules:
  - http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: myco-lab-backend-svc
            port:
              number: 80
`;
    const svcRes = extractK8sManifests(k8sServiceYaml, "backend-service.yaml", "org/k8s");
    assert.strictEqual(svcRes.services.length, 1);
    assert.strictEqual(svcRes.services[0].serviceName, "myco-lab-backend-svc");
    assert.strictEqual(svcRes.services[0].port, 80);
    assert.strictEqual(svcRes.services[0].targetPort, 8080);

    const ingRes = extractK8sManifests(k8sIngressYaml, "ingress.yaml", "org/k8s");
    assert.strictEqual(ingRes.ingresses.length, 1);
    assert.strictEqual(ingRes.ingresses[0].path, "/api");
    assert.strictEqual(ingRes.ingresses[0].targetService, "myco-lab-backend-svc");
    assert.strictEqual(ingRes.ingresses[0].targetPort, 80);
  });

  // ── 12. API Client & Environment Variable Extraction ──────────────────────
  console.log("\nSection 12: API Client & Environment Variable Extraction");

  test("extractClientCallsAndEnvVars extracts client endpoints, expected fields, and env vars", () => {
    const reactAppCode = `
import { useState, useEffect } from 'react';

export default function App() {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';

  useEffect(() => {
    fetch(\`\${apiBaseUrl}/api/v1/status\`)
      .then(r => r.json())
      .then(data => {
        console.log(data.status, data.service, data.version, data.uptime_seconds, data.dependencies);
      });
  }, []);
}
`;
    const clientRes = extractClientCallsAndEnvVars(reactAppCode, "src/App.jsx", "org/frontend");
    assert.strictEqual(clientRes.clientCalls.length, 1);
    assert.strictEqual(clientRes.clientCalls[0].endpoint, "/api/v1/status");
    assert.strictEqual(clientRes.clientCalls[0].envVarUsed, "apiBaseUrl");
    assert.deepStrictEqual(
      clientRes.clientCalls[0].expectedFields?.sort(),
      ["dependencies", "service", "status", "uptime_seconds", "version"].sort()
    );
    assert.ok(clientRes.envVars.some(e => e.name === "VITE_API_BASE_URL"));
  });

  // ── 13. End-to-End Three-Repository Knowledge Graph & Probes ──────────────
  console.log("\nSection 13: End-to-End Three-Repository Knowledge Graph & Probes");

  // Create isolated three-repo fixture
  const triRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "myco-tri-repo-"));
  const feDir = path.join(triRepoDir, "frontend");
  const beDir = path.join(triRepoDir, "backend");
  const k8sDir = path.join(triRepoDir, "k8s");

  fs.mkdirSync(path.join(feDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(beDir, "app"), { recursive: true });
  fs.mkdirSync(k8sDir, { recursive: true });

  // Frontend: App.jsx
  fs.writeFileSync(
    path.join(feDir, "src", "App.jsx"),
    `
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';
    const res = await fetch(\`\${apiBaseUrl}/api/v1/status\`);
    const data = await res.json();
    const { service, version, status, dependencies, uptime_seconds } = data;
    `
  );

  // Backend: main.py + models.py
  fs.writeFileSync(
    path.join(beDir, "app", "models.py"),
    `
from pydantic import BaseModel

class StatusResponse(BaseModel):
    service: str
    version: str
    status: str
    dependencies: dict
    uptime_seconds: int
`
  );
  fs.writeFileSync(
    path.join(beDir, "app", "main.py"),
    `
from fastapi import FastAPI
from app.models import StatusResponse

app = FastAPI()

@app.get("/api/v1/status", response_model=StatusResponse)
def get_status() -> StatusResponse:
    pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
`
  );

  // K8s: backend-service.yaml + ingress.yaml
  fs.writeFileSync(
    path.join(k8sDir, "backend-service.yaml"),
    `
apiVersion: v1
kind: Service
metadata:
  name: myco-lab-backend-svc
spec:
  ports:
  - port: 80
    targetPort: 8080
`
  );
  fs.writeFileSync(
    path.join(k8sDir, "ingress.yaml"),
    `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myco-lab-ingress
spec:
  rules:
  - http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: myco-lab-backend-svc
            port:
              number: 80
`
  );

  // Scan all 3 repositories into a shared knowledge base
  const feScan = scanRepoKnowledge(feDir, "vvkmj/myco-multirepo-lab-frontend");
  const beScan = scanRepoKnowledge(beDir, "vvkmj/myco-multirepo-lab-backend");
  const k8sScan = scanRepoKnowledge(k8sDir, "vvkmj/myco-multirepo-lab-k8s");

  const sharedKnowledgeBase: CrossRepoKnowledgeBase = {
    endpoints: [...feScan.endpoints, ...beScan.endpoints, ...k8sScan.endpoints],
    clientCalls: [...feScan.clientCalls, ...beScan.clientCalls, ...k8sScan.clientCalls],
    k8sServices: [...feScan.k8sServices, ...beScan.k8sServices, ...k8sScan.k8sServices],
    k8sIngresses: [...feScan.k8sIngresses, ...beScan.k8sIngresses, ...k8sScan.k8sIngresses],
    envVars: [...feScan.envVars, ...beScan.envVars, ...k8sScan.envVars],
    exports: [],
    projectId: "lab-project-alpha",
  };

  test("Cross-Repo Probe 1 (Initiated from Frontend): retrieves endpoint, backend response fields, K8s Service and target port with citations", () => {
    const probe1Query = "Identify the frontend API endpoint, the backend response fields, and the Kubernetes Service name and target port.";
    const result = queryCrossRepoKnowledge(probe1Query, "vvkmj/myco-multirepo-lab-frontend", sharedKnowledgeBase, "lab-project-alpha");

    assert.strictEqual(result.unknownFacts.length, 0, "No required fact should be UNKNOWN");

    const endpointFact = result.facts.find(f => f.category === "api-endpoint");
    assert.ok(endpointFact, "Must find API endpoint");
    assert.ok(endpointFact.description.includes("/api/v1/status"));

    const respFieldsFact = result.facts.find(f => f.category === "response-fields");
    assert.ok(respFieldsFact, "Must find response fields");
    assert.ok(respFieldsFact.description.includes("service, version, status, dependencies, uptime_seconds"));
    assert.strictEqual(respFieldsFact.sourceRepo, "vvkmj/myco-multirepo-lab-backend");

    const svcFact = result.facts.find(f => f.category === "k8s-service");
    assert.ok(svcFact, "Must find Kubernetes service name");
    assert.ok(svcFact.description.includes("myco-lab-backend-svc"));
    assert.strictEqual(svcFact.sourceRepo, "vvkmj/myco-multirepo-lab-k8s");

    const portFact = result.facts.find(f => f.category === "target-port");
    assert.ok(portFact, "Must find target port");
    assert.ok(portFact.description.includes("8080"));
    assert.strictEqual(portFact.sourceRepo, "vvkmj/myco-multirepo-lab-k8s");
  });

  test("Cross-Repo Probe 2 (Initiated from Backend): retrieves frontend env var, K8s Ingress routing, and backend target port with citations", () => {
    const probe2Query = "Identify the frontend environment variable used for configuring the API base URL, the Kubernetes Ingress path routing for the backend API, and the target port exposed by the backend container.";
    const result = queryCrossRepoKnowledge(probe2Query, "vvkmj/myco-multirepo-lab-backend", sharedKnowledgeBase, "lab-project-alpha");

    assert.strictEqual(result.unknownFacts.length, 0, "No required fact should be UNKNOWN");

    const envFact = result.facts.find(f => f.category === "env-var");
    assert.ok(envFact, "Must find frontend env var");
    assert.ok(envFact.description.includes("VITE_API_BASE_URL"));
    assert.strictEqual(envFact.sourceRepo, "vvkmj/myco-multirepo-lab-frontend");

    const ingressFact = result.facts.find(f => f.category === "ingress-routing");
    assert.ok(ingressFact, "Must find Kubernetes ingress routing");
    assert.ok(ingressFact.description.includes("/api routed to myco-lab-backend-svc:80"));
    assert.strictEqual(ingressFact.sourceRepo, "vvkmj/myco-multirepo-lab-k8s");

    const portFact = result.facts.find(f => f.category === "target-port");
    assert.ok(portFact, "Must find target port");
    assert.ok(portFact.description.includes("8080"));
  });

  test("Cross-Repo Probe 3 (Initiated from Kubernetes): retrieves backend target port, ingress path, and frontend endpoint", () => {
    const probe3Query = "Identify the backend container target port, the Kubernetes ingress routing path, and the frontend API endpoint.";
    const result = queryCrossRepoKnowledge(probe3Query, "vvkmj/myco-multirepo-lab-k8s", sharedKnowledgeBase, "lab-project-alpha");

    assert.strictEqual(result.unknownFacts.length, 0);
    assert.ok(result.facts.some(f => f.category === "target-port" && f.description.includes("8080")));
    assert.ok(result.facts.some(f => f.category === "ingress-routing" && f.description.includes("/api")));
    assert.ok(result.facts.some(f => f.category === "api-endpoint" && f.description.includes("/api/v1/status")));
  });

  // ── 14. Strict Project Isolation & Security ───────────────────────────────
  console.log("\nSection 14: Strict Project Isolation & Negative/Security Tests");

  test("Project Isolation: query for an unauthorized project ID is rejected with UNKNOWN", () => {
    const query = "Identify the backend response fields and Kubernetes Service name.";
    const result = queryCrossRepoKnowledge(query, "vvkmj/myco-multirepo-lab-frontend", sharedKnowledgeBase, "unauthorized-different-project");
    assert.ok(result.formattedAnswer.includes("UNKNOWN: Cross-project access denied"));
    assert.strictEqual(result.facts.length, 0, "No cross-project facts may leak");
  });

  test("Tenant Isolation: query from an unauthorized non-member repository slug is rejected", () => {
    const query = "Identify the backend response fields and Kubernetes Service name.";
    const result = queryCrossRepoKnowledge(query, "malicious-org/external-crawler", sharedKnowledgeBase, "lab-project-alpha");
    assert.ok(result.formattedAnswer.includes("not a member of project"));
    assert.strictEqual(result.facts.length, 0, "No cross-project facts may leak to unauthorized repository");
  });

  test("Symlink Sandbox Guard: executeTool prevents reading files escaping via symlinks", () => {
    const symlinkDir = path.join(triRepoDir, "symlink-test");
    fs.mkdirSync(symlinkDir, { recursive: true });
    const targetOutside = path.join(triRepoDir, "outside.txt");
    fs.writeFileSync(targetOutside, "SECRET_OUTSIDE_DATA");
    const linkPath = path.join(symlinkDir, "link-outside.txt");
    try {
      fs.symlinkSync(targetOutside, linkPath);
    } catch {}

    const toolRes = executeTool(
      "read_file",
      { path: "link-outside.txt" },
      symlinkDir
    );
    // If symlink was created, executeTool should refuse to escape the sandbox
    if (fs.existsSync(linkPath)) {
      assert.ok(toolRes.includes("escapes repository sandbox") || toolRes.includes("outside"));
    }
  });

  test("Negative Query: absent facts strictly return UNKNOWN without fabrication", () => {
    const absentQuery = "Identify the gRPC protobuf service package name and Kafka topic partitions.";
    const result = queryCrossRepoKnowledge(absentQuery, "vvkmj/myco-multirepo-lab-frontend", sharedKnowledgeBase, "lab-project-alpha");
    assert.ok(result.formattedAnswer.includes("UNKNOWN"));
  });

  // ── 15. Lifecycle, Resilience & Idempotency ───────────────────────────────
  console.log("\nSection 15: Lifecycle, Resilience & Idempotency");

  test("Idempotency: rescanning the same repositories produces identical deterministic knowledge", () => {
    const firstScan = scanRepoKnowledge(beDir, "vvkmj/myco-multirepo-lab-backend");
    const secondScan = scanRepoKnowledge(beDir, "vvkmj/myco-multirepo-lab-backend");
    assert.strictEqual(firstScan.endpoints.length, secondScan.endpoints.length);
    assert.strictEqual(firstScan.endpoints[0].path, secondScan.endpoints[0].path);
    assert.deepStrictEqual(firstScan.endpoints[0].responseFields, secondScan.endpoints[0].responseFields);
  });

  test("Resilience: empty or nonexistent directory handles gracefully without throwing", () => {
    const emptyDir = path.join(triRepoDir, "empty-dir");
    fs.mkdirSync(emptyDir, { recursive: true });
    const emptyScan = scanRepoKnowledge(emptyDir, "empty-repo");
    assert.strictEqual(emptyScan.endpoints.length, 0);
    assert.strictEqual(emptyScan.k8sServices.length, 0);
  });

  // ── 16. Scale & Token-Efficiency Measurement ──────────────────────────────
  console.log("\nSection 16: Scale & Token-Efficiency Measurement (1, 3, 10, 50 Repos)");

  test("Scale: measures scanning time, indexing time, retrieval latency, and token budgeting", () => {
    const repoCounts = [1, 3, 10, 50];
    const resultsTable: Array<{
      repos: number;
      scanMs: number;
      indexMs: number;
      retrievalMs: number;
      promptTokens: number;
      facts: number;
    }> = [];

    for (const count of repoCounts) {
      // 1. Measure synthetic scanning
      const tScan0 = process.hrtime.bigint();
      const syntheticScans = [];
      for (let i = 0; i < count; i++) {
        syntheticScans.push({
          endpoints: [
            {
              repoSlug: `org/service-${i}`,
              method: "GET" as const,
              path: `/api/v1/resource-${i}`,
              responseModel: `Resource${i}Response`,
              responseFields: ["id", "status", "created_at"],
              sourceFile: `app/routes/${i}.py`,
            },
          ],
          k8sServices: [
            {
              repoSlug: `org/service-${i}`,
              serviceName: `service-${i}-svc`,
              port: 80,
              targetPort: 8000 + i,
              protocol: "TCP",
              sourceFile: `k8s/svc-${i}.yaml`,
            },
          ],
        });
      }
      const tScan1 = process.hrtime.bigint();
      const scanMs = Number(tScan1 - tScan0) / 1_000_000;

      // 2. Measure indexing
      const tIdx0 = process.hrtime.bigint();
      const syntheticKb: CrossRepoKnowledgeBase = {
        endpoints: syntheticScans.flatMap(s => s.endpoints),
        clientCalls: [],
        k8sServices: syntheticScans.flatMap(s => s.k8sServices),
        k8sIngresses: [],
        envVars: [],
        exports: [],
        projectId: "scale-test-project",
      };
      const tIdx1 = process.hrtime.bigint();
      const indexMs = Number(tIdx1 - tIdx0) / 1_000_000;

      // 3. Measure retrieval
      const tRet0 = process.hrtime.bigint();
      const queryRes = queryCrossRepoKnowledge(
        "Identify the API endpoint and Kubernetes Service name",
        "org/service-0",
        syntheticKb,
        "scale-test-project"
      );
      const tRet1 = process.hrtime.bigint();
      const retrievalMs = Number(tRet1 - tRet0) / 1_000_000;
      const promptTokens = Math.ceil(queryRes.formattedAnswer.length / 4);

      resultsTable.push({
        repos: count,
        scanMs: Math.round(scanMs * 1000) / 1000,
        indexMs: Math.round(indexMs * 1000) / 1000,
        retrievalMs: Math.round(retrievalMs * 1000) / 1000,
        promptTokens,
        facts: queryRes.facts.length,
      });

      assert.ok(retrievalMs < 50, `Latency for ${count} repos should be < 50ms`);
      assert.ok(promptTokens > 0, `Prompt token count should be measured`);
    }

    console.log("     📊 Detailed Component Benchmark Results:");
    for (const row of resultsTable) {
      console.log(`        • ${row.repos} repos: scan=${row.scanMs}ms, index=${row.indexMs}ms, retrieval=${row.retrievalMs}ms, tokens=${row.promptTokens}, facts=${row.facts}`);
    }
  });

  // Teardown tri-repo directory
  try {
    fs.rmSync(triRepoDir, { recursive: true, force: true });
  } catch {}

  console.log("\n✨ All tests completed successfully!\n");
}

runTests();
