import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { MergePolicyDecision } from "../prd/mergePolicy";
import { ConnectorOrchestratorResult } from "../connectors/connectorRegistry";
import { buildPrdSummary } from "../prd/prdReport";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Checks and Commit Status Reporter for PRD Validation
//
// Publishes check-runs or commit statuses to enforce merge protection.
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckReporterOptions {
  owner: string;
  repo: string;
  headSha: string;
  prNumber?: number;
  githubToken?: string;
  outputDir?: string;
}

export interface CheckReporterResult {
  checkRunPublished: boolean;
  commitStatusPublished: boolean;
  commentPosted: boolean;
  localReportsWritten: boolean;
  error?: string;
}

export async function reportPrdValidationToGitHub(
  decision: MergePolicyDecision,
  connectorResult: ConnectorOrchestratorResult,
  options: CheckReporterOptions
): Promise<CheckReporterResult> {
  const result: CheckReporterResult = {
    checkRunPublished: false,
    commitStatusPublished: false,
    commentPosted: false,
    localReportsWritten: false,
  };

  const { owner, repo, headSha, githubToken, outputDir } = options;
  const token = githubToken || process.env.GITHUB_TOKEN;
  const isPass = decision.result === "PASS";
  const summaryMarkdown = buildPrdSummary(decision, connectorResult);

  // 1. Write local reports
  try {
    const reportDir = outputDir || path.join(process.cwd(), "reports");
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const mdPath = path.join(reportDir, "prd-validation.md");
    fs.writeFileSync(mdPath, summaryMarkdown, "utf-8");

    const jsonPath = path.join(reportDir, "prd-validation.json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          decision: decision.result,
          reason: decision.reason,
          failedMandatoryCount: decision.failedMandatory.length,
          inconclusiveMandatoryCount: decision.inconclusiveMandatory.length,
          failedOptionalCount: decision.failedOptional.length,
          allResultsCount: decision.allResults.length,
          allResults: decision.allResults,
          hasCredentialGaps: decision.hasCredentialGaps,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );
    result.localReportsWritten = true;
    console.log(`  📄  PRD validation reports saved to ${mdPath} and ${jsonPath}`);
  } catch (err: any) {
    console.warn(`  ⚠️   Failed to write local reports: ${err.message}`);
  }

  if (!token || !owner || !repo || !headSha) {
    console.log("  ℹ️   GitHub credentials/context missing — skipped GitHub Check publishing.");
    return result;
  }

  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Myco-PRD-Validator",
  };

  // 2. Try GitHub Checks API
  try {
    const checkUrl = `https://api.github.com/repos/${owner}/${repo}/check-runs`;
    const checkPayload = {
      name: "Myco PRD Validation",
      head_sha: headSha,
      status: "completed",
      conclusion: isPass ? "success" : "failure",
      completed_at: new Date().toISOString(),
      output: {
        title: isPass
          ? "PRD Validation Passed"
          : `PRD Validation Failed: ${decision.failedMandatory.length} requirement(s) failed`,
        summary: `**${decision.reason}**\n\n${connectorResult.summary}`,
        text: summaryMarkdown,
      },
    };

    const checkRes = await axios.post(checkUrl, checkPayload, { headers, timeout: 10000 });
    if (checkRes.status === 201 || checkRes.status === 200) {
      result.checkRunPublished = true;
      console.log(`  ✅  GitHub Check Run published: ${checkRes.data.html_url || checkRes.data.id}`);
    }
  } catch (err: any) {
    const status = err.response?.status;
    console.log(`  ℹ️   GitHub Checks API not accessible (HTTP ${status || err.message}) — falling back to Commit Status API.`);
  }

  // 3. Fallback / supplementary Commit Status API (always succeeds with standard repo scope)
  try {
    const statusUrl = `https://api.github.com/repos/${owner}/${repo}/statuses/${headSha}`;
    const statusDesc = isPass
      ? "All mandatory requirements verified"
      : `${decision.failedMandatory.length} mandatory requirement(s) failed validation`;

    const statusPayload = {
      state: isPass ? "success" : "failure",
      context: "myco/prd-validation",
      description: statusDesc.slice(0, 140),
      target_url: options.prNumber
        ? `https://github.com/${owner}/${repo}/pull/${options.prNumber}`
        : undefined,
    };

    const statusRes = await axios.post(statusUrl, statusPayload, { headers, timeout: 10000 });
    if (statusRes.status === 201 || statusRes.status === 200) {
      result.commitStatusPublished = true;
      console.log(`  ✅  GitHub Commit Status published: "myco/prd-validation" -> ${statusPayload.state}`);
    }
  } catch (err: any) {
    console.warn(`  ⚠️   Failed to publish GitHub commit status: ${err.response?.data?.message || err.message}`);
    result.error = err.message;
  }

  // 4. Post PR comment if prNumber is provided
  if (options.prNumber) {
    try {
      const commentUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${options.prNumber}/comments`;
      const commentBody = `<!-- myco-prd-validation-report -->\n${summaryMarkdown}`;
      await axios.post(commentUrl, { body: commentBody }, { headers, timeout: 10000 });
      result.commentPosted = true;
      console.log(`  💬  PRD validation summary commented on PR #${options.prNumber}`);
    } catch (err: any) {
      console.warn(`  ⚠️   Failed to post PR comment: ${err.response?.data?.message || err.message}`);
    }
  }

  return result;
}
