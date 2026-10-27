import path from "path";
import assert from "assert";
import {
  scanRepoKnowledge,
  queryCrossRepoKnowledge,
  CrossRepoKnowledgeBase,
} from "../src/multirepo/multiRepoAnalyser";

async function runDemoVerification() {
  console.log("================================================================================");
  console.log("   E2E MULTI-REPO VERIFICATION ON REAL DEMO REPOSITORIES");
  console.log("================================================================================\n");

  const feDir = path.resolve(__dirname, "../multirepo-lab/myco-multirepo-lab-frontend");
  const beDir = path.resolve(__dirname, "../multirepo-lab/myco-multirepo-lab-backend");
  const k8sDir = path.resolve(__dirname, "../multirepo-lab/myco-multirepo-lab-k8s");

  const feSlug = "vvkmj/myco-multirepo-lab-frontend";
  const beSlug = "vvkmj/myco-multirepo-lab-backend";
  const k8sSlug = "vvkmj/myco-multirepo-lab-k8s";

  const projectId = "myco-multirepo-lab-prod";

  console.log(`[1] Scanning 3 demo repositories for Project "${projectId}"...`);
  const tScan0 = process.hrtime.bigint();
  const feScan = scanRepoKnowledge(feDir, feSlug);
  const beScan = scanRepoKnowledge(beDir, beSlug);
  const k8sScan = scanRepoKnowledge(k8sDir, k8sSlug);
  const tScan1 = process.hrtime.bigint();
  const scanDurationMs = Number(tScan1 - tScan0) / 1_000_000;

  console.log(`    Scan complete in ${scanDurationMs.toFixed(3)}ms.`);

  const tIdx0 = process.hrtime.bigint();
  const sharedKnowledgeBase: CrossRepoKnowledgeBase = {
    endpoints: [...feScan.endpoints, ...beScan.endpoints, ...k8sScan.endpoints],
    clientCalls: [...feScan.clientCalls, ...beScan.clientCalls, ...k8sScan.clientCalls],
    k8sServices: [...feScan.k8sServices, ...beScan.k8sServices, ...k8sScan.k8sServices],
    k8sIngresses: [...feScan.k8sIngresses, ...beScan.k8sIngresses, ...k8sScan.k8sIngresses],
    envVars: [...feScan.envVars, ...beScan.envVars, ...k8sScan.envVars],
    exports: [],
    projectId,
  };
  const tIdx1 = process.hrtime.bigint();
  const indexDurationMs = Number(tIdx1 - tIdx0) / 1_000_000;
  console.log(`    Indexing complete in ${indexDurationMs.toFixed(3)}ms.`);
  console.log(`    Indexed: ${sharedKnowledgeBase.endpoints.length} endpoint(s), ${sharedKnowledgeBase.clientCalls.length} client call(s), ${sharedKnowledgeBase.k8sServices.length} K8s service(s), ${sharedKnowledgeBase.k8sIngresses.length} ingress(es), ${sharedKnowledgeBase.envVars.length} env var(s).\n`);

  // PROBE 1: Frontend Context
  console.log("[2] Executing Probe 1 (Initiated from Frontend Context)...");
  const p1Query = "Identify the frontend API endpoint, the backend response fields, and the Kubernetes Service name and target port.";
  const tP1_0 = process.hrtime.bigint();
  const p1 = queryCrossRepoKnowledge(p1Query, feSlug, sharedKnowledgeBase, projectId);
  const tP1_1 = process.hrtime.bigint();
  const p1LatencyMs = Number(tP1_1 - tP1_0) / 1_000_000;
  const p1Tokens = Math.ceil(p1.formattedAnswer.length / 4);

  console.log("    --- Probe 1 Answer ---");
  console.log(p1.formattedAnswer);
  console.log(`    Latency: ${p1LatencyMs.toFixed(3)}ms | Facts: ${p1.facts.length} | Prompt Tokens: ${p1Tokens}`);
  assert.strictEqual(p1.unknownFacts.length, 0);
  assert.ok(p1.formattedAnswer.includes("/api/v1/status"));
  assert.ok(p1.formattedAnswer.includes("service, version, status, dependencies, uptime_seconds"));
  assert.ok(p1.formattedAnswer.includes("myco-lab-backend-svc"));
  assert.ok(p1.formattedAnswer.includes("8080"));

  // PROBE 2: Backend Context
  console.log("\n[3] Executing Probe 2 (Initiated from Backend Context)...");
  const p2Query = "Identify the frontend environment variable used for configuring the API base URL, the Kubernetes Ingress path routing for the backend API, and the target port exposed by the backend container.";
  const tP2_0 = process.hrtime.bigint();
  const p2 = queryCrossRepoKnowledge(p2Query, beSlug, sharedKnowledgeBase, projectId);
  const tP2_1 = process.hrtime.bigint();
  const p2LatencyMs = Number(tP2_1 - tP2_0) / 1_000_000;
  const p2Tokens = Math.ceil(p2.formattedAnswer.length / 4);

  console.log("    --- Probe 2 Answer ---");
  console.log(p2.formattedAnswer);
  console.log(`    Latency: ${p2LatencyMs.toFixed(3)}ms | Facts: ${p2.facts.length} | Prompt Tokens: ${p2Tokens}`);
  assert.strictEqual(p2.unknownFacts.length, 0);
  assert.ok(p2.formattedAnswer.includes("VITE_API_BASE_URL"));
  assert.ok(p2.formattedAnswer.includes("/api"));
  assert.ok(p2.formattedAnswer.includes("8080"));

  // PROBE 3: Kubernetes Context
  console.log("\n[4] Executing Probe 3 (Initiated from Kubernetes Context)...");
  const p3Query = "Identify the backend target port, ingress path, and frontend endpoint.";
  const tP3_0 = process.hrtime.bigint();
  const p3 = queryCrossRepoKnowledge(p3Query, k8sSlug, sharedKnowledgeBase, projectId);
  const tP3_1 = process.hrtime.bigint();
  const p3LatencyMs = Number(tP3_1 - tP3_0) / 1_000_000;
  const p3Tokens = Math.ceil(p3.formattedAnswer.length / 4);

  console.log("    --- Probe 3 Answer ---");
  console.log(p3.formattedAnswer);
  console.log(`    Latency: ${p3LatencyMs.toFixed(3)}ms | Facts: ${p3.facts.length} | Prompt Tokens: ${p3Tokens}`);
  assert.strictEqual(p3.unknownFacts.length, 0);
  assert.ok(p3.formattedAnswer.includes("8080"));
  assert.ok(p3.formattedAnswer.includes("/api"));
  assert.ok(p3.formattedAnswer.includes("/api/v1/status"));

  // PROBE 4: Security & Project Isolation
  console.log("\n[5] Executing Probe 4 (Project Isolation & Security)...");
  const p4 = queryCrossRepoKnowledge(p1Query, feSlug, sharedKnowledgeBase, "unauthorized-tenant-xyz");
  console.log("    --- Unauthorized Project Result ---");
  console.log(p4.formattedAnswer);
  assert.ok(p4.formattedAnswer.startsWith("UNKNOWN"));
  assert.strictEqual(p4.facts.length, 0);

  // PROBE 5: Tenant Isolation Check
  console.log("\n[6] Executing Probe 5 (Tenant Boundary Enforcement)...");
  const p5 = queryCrossRepoKnowledge(p1Query, "malicious-org/external-repo", sharedKnowledgeBase, projectId);
  console.log("    --- Unauthorized Repository Result ---");
  console.log(p5.formattedAnswer);
  assert.ok(p5.formattedAnswer.includes("not a member of project"));
  assert.strictEqual(p5.facts.length, 0);

  // PROBE 6: Negative Query
  console.log("\n[7] Executing Probe 6 (Negative Fact Query)...");
  const p6 = queryCrossRepoKnowledge("What is the AWS secret key and Redis password?", feSlug, sharedKnowledgeBase, projectId);
  console.log("    --- Negative Fact Result ---");
  console.log(p6.formattedAnswer);
  assert.ok(p6.formattedAnswer.startsWith("UNKNOWN"));
  assert.strictEqual(p6.facts.length, 0);

  console.log("\n================================================================================");
  console.log("   ✅ ALL REAL REPOSITORY CROSS-REPO VERIFICATIONS PASSED 100%");
  console.log("================================================================================\n");
}

runDemoVerification().catch(err => {
  console.error("❌ Demo verification failed:", err);
  process.exit(1);
});
