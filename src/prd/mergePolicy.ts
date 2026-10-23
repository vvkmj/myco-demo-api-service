import { RequirementValidationResult, ValidationStatus, NormalizedRequirement } from "../connectors/types";
import { ConnectorOrchestratorResult } from "../connectors/connectorRegistry";

// ─────────────────────────────────────────────────────────────────────────────
// Merge policy engine
//
// Determines whether a PR should be allowed to merge based on requirement
// validation results. Policy is configurable via environment variables.
// ─────────────────────────────────────────────────────────────────────────────

export type MergePolicyResult = "PASS" | "FAIL" | "WARN";

export interface MergePolicyDecision {
  /** Overall merge decision */
  result: MergePolicyResult;
  /** Human-readable reason for the decision */
  reason: string;
  /** Failed mandatory requirements */
  failedMandatory: RequirementValidationResult[];
  /** Inconclusive mandatory requirements */
  inconclusiveMandatory: RequirementValidationResult[];
  /** Failed optional/recommended requirements */
  failedOptional: RequirementValidationResult[];
  /** All validation results */
  allResults: RequirementValidationResult[];
  /** Whether credential gaps caused INCONCLUSIVE results */
  hasCredentialGaps: boolean;
  /** Detailed policy breakdown */
  policyBreakdown: string[];
}

export interface MergePolicyConfig {
  /** Whether to fail on INCONCLUSIVE mandatory requirements (default: true) */
  failOnInconclusive: boolean;
  /** Whether to fail on missing credentials causing INCONCLUSIVE (default: true) */
  failOnMissingCredentials: boolean;
  /** How to treat optional requirements: "warn" | "ignore" (default: "warn") */
  optionalPolicy: "warn" | "ignore";
  /** Whether PRD validation is enabled at all (default: false until explicitly enabled) */
  prdValidationEnabled: boolean;
  /** Minimum number of requirements that must pass for overall PASS */
  minPassCount?: number;
}

/** Build merge policy config from environment variables */
export function buildMergePolicyConfig(): MergePolicyConfig {
  return {
    prdValidationEnabled: process.env.PRD_VALIDATION === "true",
    failOnInconclusive: process.env.PRD_FAIL_ON_INCONCLUSIVE !== "false", // default true
    failOnMissingCredentials: process.env.PRD_FAIL_ON_MISSING_CREDS !== "false", // default true
    optionalPolicy: (process.env.PRD_OPTIONAL_POLICY || "warn") as "warn" | "ignore",
    minPassCount: process.env.PRD_MIN_PASS_COUNT
      ? parseInt(process.env.PRD_MIN_PASS_COUNT, 10)
      : undefined,
  };
}

/**
 * Evaluate the merge policy against validation results.
 *
 * Rules:
 * - FAIL on any unmet mandatory requirement.
 * - FAIL when required validation tests fail.
 * - FAIL when a mandatory requirement cannot be validated because of missing
 *   credentials or unavailable sources (configurable).
 * - PASS only when all mandatory requirements are validated successfully.
 * - Treat optional requirements according to the configured policy.
 * - Never allow an LLM response alone to override a failed deterministic check.
 */
export function evaluateMergePolicy(
  results: RequirementValidationResult[],
  connectorResult: ConnectorOrchestratorResult,
  config: MergePolicyConfig
): MergePolicyDecision {
  const policyBreakdown: string[] = [];

  // Categorize results by severity
  const mandatoryResults = results.filter(r => r.requirement.severity === "mandatory");
  const optionalResults = results.filter(r =>
    r.requirement.severity === "optional" || r.requirement.severity === "recommended"
  );

  const failedMandatory = mandatoryResults.filter(r => r.status === "FAIL");
  const inconclusiveMandatory = mandatoryResults.filter(r => r.status === "INCONCLUSIVE");
  const passedMandatory = mandatoryResults.filter(r => r.status === "PASS");
  const failedOptional = optionalResults.filter(r => r.status === "FAIL");

  // Rule 1: FAIL on any unmet mandatory requirement
  if (failedMandatory.length > 0) {
    policyBreakdown.push(
      `❌ ${failedMandatory.length} mandatory requirement(s) FAILED:`
    );
    for (const r of failedMandatory) {
      policyBreakdown.push(`   - [${r.requirement.id}] ${r.requirement.title}: ${r.missingFunctionality || r.evidence}`);
    }
  }

  // Rule 2: FAIL on INCONCLUSIVE mandatory requirements (if configured)
  if (config.failOnInconclusive && inconclusiveMandatory.length > 0) {
    policyBreakdown.push(
      `⚠️  ${inconclusiveMandatory.length} mandatory requirement(s) INCONCLUSIVE:`
    );
    for (const r of inconclusiveMandatory) {
      policyBreakdown.push(`   - [${r.requirement.id}] ${r.requirement.title}: ${r.inconclusiveReason || "validation incomplete"}`);
    }
  }

  // Rule 3: FAIL on missing credentials or unreachable sources
  const hasCredentialGaps = connectorResult.hasCredentialGaps;
  const hasUnreachableSources = connectorResult.hasUnreachableSources;

  if (hasUnreachableSources) {
    policyBreakdown.push(
      `🌐 One or more configured PRD / requirement sources were unreachable or failed to load.`
    );
  }

  if (config.failOnMissingCredentials && hasCredentialGaps) {
    policyBreakdown.push(
      `🔒 Missing credentials prevented validation of some requirements. ` +
      `Configure JIRA_TOKEN, CONFLUENCE_TOKEN, or other required credentials.`
    );
  }

  // Rule 4: Optional requirements
  if (config.optionalPolicy === "warn" && failedOptional.length > 0) {
    policyBreakdown.push(
      `ℹ️  ${failedOptional.length} optional/recommended requirement(s) not met (non-blocking):`
    );
    for (const r of failedOptional) {
      policyBreakdown.push(`   - [${r.requirement.id}] ${r.requirement.title}`);
    }
  }

  // Rule 5: Minimum pass count
  if (config.minPassCount !== undefined && passedMandatory.length < config.minPassCount) {
    policyBreakdown.push(
      `❌ Only ${passedMandatory.length}/${config.minPassCount} mandatory requirements passed (minimum: ${config.minPassCount}).`
    );
  }

  // Determine overall result
  let result: MergePolicyResult = "PASS";
  let reason: string;

  if (failedMandatory.length > 0) {
    result = "FAIL";
    reason = `${failedMandatory.length} mandatory requirement(s) failed validation.`;
  } else if (hasUnreachableSources) {
    result = "FAIL";
    reason = `Configured PRD / requirement source was unreachable or failed to load.`;
  } else if (config.failOnInconclusive && inconclusiveMandatory.length > 0) {
    result = "FAIL";
    reason = `${inconclusiveMandatory.length} mandatory requirement(s) could not be validated (INCONCLUSIVE).`;
  } else if (config.failOnMissingCredentials && hasCredentialGaps && inconclusiveMandatory.length > 0) {
    result = "FAIL";
    reason = `Missing credentials prevented validation of ${inconclusiveMandatory.length} mandatory requirement(s).`;
  } else if (config.minPassCount !== undefined && passedMandatory.length < config.minPassCount) {
    result = "FAIL";
    reason = `Minimum pass count not met: ${passedMandatory.length}/${config.minPassCount}.`;
  } else if (failedOptional.length > 0) {
    result = "WARN";
    reason = `All mandatory requirements passed. ${failedOptional.length} optional requirement(s) not met.`;
  } else {
    reason = `All ${mandatoryResults.length} mandatory requirement(s) passed validation.`;
  }

  policyBreakdown.unshift(`📊 PRD Merge Policy: ${result} — ${reason}`);

  return {
    result,
    reason,
    failedMandatory,
    inconclusiveMandatory,
    failedOptional,
    allResults: results,
    hasCredentialGaps,
    policyBreakdown,
  };
}
