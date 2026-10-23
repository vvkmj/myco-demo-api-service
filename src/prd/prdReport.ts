import { RequirementValidationResult, NormalizedRequirement } from "../connectors/types";
import { ConnectorOrchestratorResult } from "../connectors/connectorRegistry";
import { MergePolicyDecision } from "./mergePolicy";

// ─────────────────────────────────────────────────────────────────────────────
// PRD validation report builder
//
// Generates structured validation reports for GitHub Checks, PR comments,
// and review output files.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a concise markdown summary for GitHub Check / PR comment */
export function buildPrdSummary(
  decision: MergePolicyDecision,
  connectorResult: ConnectorOrchestratorResult
): string {
  const parts: string[] = [];

  const icon = decision.result === "PASS" ? "✅" : decision.result === "FAIL" ? "❌" : "⚠️";
  parts.push(`## ${icon} PRD Validation: ${decision.result}`);
  parts.push("");
  parts.push(`**${decision.reason}**`);
  parts.push("");

  // Results table
  if (decision.allResults.length > 0) {
    parts.push("### Requirement Validation Results");
    parts.push("");
    parts.push("| Requirement | Source | Priority | Status | Evidence |");
    parts.push("|---|---|---|---|---|");

    for (const r of decision.allResults) {
      const statusIcon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⚠️";
      const evidence = (r.evidence || "").slice(0, 120);
      const sourceLink = r.requirement.sourceUrl
        ? `[${r.requirement.source}](${r.requirement.sourceUrl})`
        : r.requirement.source;
      parts.push(
        `| **[${r.requirement.id}]** ${r.requirement.title.slice(0, 60)} | ${sourceLink} | ${r.requirement.priority} | ${statusIcon} ${r.status} | ${evidence} |`
      );
    }
    parts.push("");
  }

  // Failed requirements detail
  if (decision.failedMandatory.length > 0) {
    parts.push("### ❌ Failed Mandatory Requirements");
    parts.push("");
    for (const r of decision.failedMandatory) {
      parts.push(`#### [${r.requirement.id}] ${r.requirement.title}`);
      parts.push(`- **Source:** ${r.requirement.sourceUrl || r.requirement.source}`);
      parts.push(`- **Evidence:** ${r.evidence}`);
      if (r.missingFunctionality) {
        parts.push(`- **Missing:** ${r.missingFunctionality}`);
      }
      if (r.codeLocations.length > 0) {
        parts.push(`- **Code:** ${r.codeLocations.join(", ")}`);
      }
      parts.push("");
    }
  }

  // Inconclusive requirements
  if (decision.inconclusiveMandatory.length > 0) {
    parts.push("### ⚠️ Inconclusive Mandatory Requirements");
    parts.push("");
    for (const r of decision.inconclusiveMandatory) {
      parts.push(`- **[${r.requirement.id}]** ${r.requirement.title}: ${r.inconclusiveReason || "validation incomplete"}`);
    }
    parts.push("");
  }

  // Connector diagnostics
  if (connectorResult.hasCredentialGaps || connectorResult.hasUnreachableSources) {
    parts.push("### 🔒 Connector Status");
    parts.push("");
    parts.push(connectorResult.summary);
    parts.push("");
  }

  // Policy breakdown
  if (decision.policyBreakdown.length > 1) {
    parts.push("### Policy Details");
    parts.push("");
    for (const line of decision.policyBreakdown.slice(1)) {
      parts.push(line);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/** Build a detailed report section for the review markdown file */
export function buildPrdReportSection(
  decision: MergePolicyDecision,
  connectorResult: ConnectorOrchestratorResult
): string {
  const summary = buildPrdSummary(decision, connectorResult);
  return `\n\n---\n\n### Section 6 — PRD Validation\n\n${summary}\n`;
}

/** Build a JSON-serializable validation report */
export function buildPrdJsonReport(
  decision: MergePolicyDecision,
  connectorResult: ConnectorOrchestratorResult
): object {
  return {
    prdValidation: {
      result: decision.result,
      reason: decision.reason,
      hasCredentialGaps: decision.hasCredentialGaps,
      requirements: decision.allResults.map(r => ({
        id: r.requirement.id,
        title: r.requirement.title,
        source: r.requirement.source,
        sourceUrl: r.requirement.sourceUrl,
        priority: r.requirement.priority,
        severity: r.requirement.severity,
        status: r.status,
        evidence: r.evidence,
        codeLocations: r.codeLocations,
        missingFunctionality: r.missingFunctionality,
        inconclusiveReason: r.inconclusiveReason,
      })),
      connectors: connectorResult.connectorResults.map(c => ({
        source: c.source,
        success: c.success,
        requirementCount: c.requirements.length,
        error: c.error,
        credentialsMissing: c.credentialsMissing,
      })),
      policy: decision.policyBreakdown,
    },
  };
}
