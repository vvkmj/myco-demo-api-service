import {
  MultiRepoAnalysis,
  CrossRepoAnalysisResult,
  CrossRepoKnowledgeBase,
  CrossRepoFactQueryResult,
  queryCrossRepoKnowledge,
} from "./multiRepoAnalyser";
import { MultiRepoResolution, ExternalRepoDependency } from "./multiRepoResolver";
import { ClonedExternalRepo } from "./multiRepoCloner";
import { FindingCard } from "../review/finding";
import { ValidatedFinding } from "../validate/findingValidator";
import * as path from "path";
import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete multi-repo context bundle, ready to be injected into the
 * existing review and validation pipelines.
 */
export interface MultiRepoContext {
  /** Whether multi-repo analysis was performed. */
  enabled: boolean;
  /** Cross-repo context to inject into the LLM review prompt. */
  reviewContext: string;
  /** Cross-repo context to inject into the validator prompt. */
  validatorContext: string;
  /** Deterministic cross-repo findings (broken imports, missing exports). */
  staticFindings: FindingCard[];
  /** Map of repo slug → local path for multi-repo read_file tool access. */
  repoPathMap: Map<string, string>;
  /** Summary of cross-repo analysis for the review markdown. */
  analysisSummary: string;
  /** Unmapped imports that couldn't be resolved to repos. */
  unmappedImports: string[];
  /** Project-wide synthesized knowledge base. */
  knowledgeBase?: CrossRepoKnowledgeBase;
  /** Estimated token count of injected cross-repo context. */
  tokenCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt building helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the cross-repo context section for the review prompt.
 * This is injected between the code context and test coverage sections.
 */
function buildReviewContextSection(analysis: MultiRepoAnalysis, resolution: MultiRepoResolution): string {
  if (!analysis.contextForReview && analysis.findings.length === 0) {
    return "";
  }

  const parts: string[] = [
    `## Cross-Repository Context`,
    ``,
    `This PR has dependencies on ${resolution.dependencies.length} external repository/ies. ` +
    `The following analysis was performed automatically — treat it as verified context.`,
    ``,
  ];

  // Include the context from the analyser
  if (analysis.contextForReview) {
    parts.push(analysis.contextForReview);
    parts.push("");
  }

  // Highlight broken imports as a priority issue
  const brokenImports = analysis.results.filter((r) => r.brokenImports.length > 0);
  if (brokenImports.length > 0) {
    parts.push(`### ⚠️ Cross-Repo Import Issues Detected`);
    parts.push(``);
    for (const result of brokenImports) {
      parts.push(
        `- **${result.repoSlug}**: Missing exports: ${result.brokenImports.join(", ")}`
      );
    }
    parts.push(``);
    parts.push(
      `These missing imports will cause build failures. ` +
      `Deterministic findings have been generated automatically (P1-XREPO-*). ` +
      `In your review, note any additional context about why these imports might be missing ` +
      `(e.g. if the PR depends on a yet-to-be-merged change in the external repo).`
    );
    parts.push(``);
  }

  // Note consumed exports (reverse deps)
  const withConsumers = analysis.results.filter((r) => r.consumedExports.length > 0);
  if (withConsumers.length > 0) {
    parts.push(`### Reverse Dependencies (External repos consuming this repo's exports)`);
    parts.push(``);
    for (const result of withConsumers) {
      parts.push(
        `- **${result.repoSlug}** consumes: ${result.consumedExports.join(", ")}`
      );
    }
    parts.push(``);
    parts.push(
      `If any of these consumed exports are modified (e.g. changed parameters, added required arguments, ` +
      `altered return types, removed interface properties, or modified runtime behavior) or removed in this PR, ` +
      `it will break downstream consumer repositories. Flag any incompatible modification as a merge-blocking P1 bug.`
    );
    parts.push(``);
  }

  // Note unmapped imports
  if (resolution.unmappedImports.length > 0) {
    parts.push(`### Unmapped External Imports`);
    parts.push(``);
    parts.push(`The following import specifiers could not be mapped to a repository:`);
    for (const imp of resolution.unmappedImports.slice(0, 10)) {
      parts.push(`- \`${imp}\``);
    }
    parts.push(``);
  }

  return parts.join("\n");
}

/**
 * Build the cross-repo context section for the validator prompt.
 * Shorter and more focused than the review context.
 */
function buildValidatorContextSection(analysis: MultiRepoAnalysis): string {
  if (analysis.findings.length === 0 && analysis.results.every((r) => r.verifiedImports.length === 0)) {
    return "";
  }

  const parts: string[] = [
    `## Cross-Repository Verification Context`,
    ``,
    `Cross-repo analysis was performed on ${analysis.results.length} external repo(s).`,
  ];

  for (const result of analysis.results) {
    if (!result.success) continue;
    parts.push(`- **${result.repoSlug}**: ${result.verifiedImports.length} import(s) verified, ${result.brokenImports.length} broken.`);
  }

  if (analysis.findings.length > 0) {
    parts.push(``);
    parts.push(
      `Note: P1-XREPO-* findings are deterministic (statically verified against ` +
      `the actual external repo contents) and should be CONFIRMED unless the ` +
      `import specifier is a workspace alias that resolves differently at build time.`
    );
  }

  return parts.join("\n");
}

/**
 * Build a summary section for the review markdown output file.
 */
function buildAnalysisSummary(
  analysis: MultiRepoAnalysis,
  resolution: MultiRepoResolution,
  clonedRepos: ClonedExternalRepo[]
): string {
  const parts: string[] = [
    `\n\n---\n\n### Cross-Repository Analysis Summary\n`,
  ];

  const totalDeps = resolution.dependencies.length;
  const clonedCount = clonedRepos.filter((r) => r.success).length;
  const failedCount = clonedRepos.filter((r) => !r.success).length;
  const totalVerified = analysis.results.reduce((sum, r) => sum + r.verifiedImports.length, 0);
  const totalBroken = analysis.results.reduce((sum, r) => sum + r.brokenImports.length, 0);
  const totalConsumed = analysis.results.reduce((sum, r) => sum + r.consumedExports.length, 0);

  parts.push(`| Metric | Value |`);
  parts.push(`|--------|-------|`);
  parts.push(`| External repos detected | ${totalDeps} |`);
  parts.push(`| Successfully cloned | ${clonedCount} |`);
  if (failedCount > 0) parts.push(`| Failed to clone | ${failedCount} |`);
  parts.push(`| Import symbols verified | ${totalVerified} |`);
  parts.push(`| Import symbols broken | ${totalBroken} |`);
  if (totalConsumed > 0) parts.push(`| Exports consumed by external repos | ${totalConsumed} |`);
  if (resolution.unmappedImports.length > 0) {
    parts.push(`| Unmapped import specifiers | ${resolution.unmappedImports.length} |`);
  }

  // Detail table per repo
  if (analysis.results.length > 0) {
    parts.push(``);
    parts.push(`| Repository | Status | Verified | Broken | Consumed |`);
    parts.push(`|------------|--------|----------|--------|----------|`);
    for (const result of analysis.results) {
      const status = result.success ? "✅" : "❌";
      parts.push(
        `| ${result.repoSlug} | ${status} | ${result.verifiedImports.length} | ${result.brokenImports.length} | ${result.consumedExports.length} |`
      );
    }
  }

  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the complete multi-repo context bundle from resolution, cloning,
 * and analysis results. This is the single integration point consumed by
 * index.ts to wire multi-repo data into the existing pipeline.
 */
export function buildMultiRepoContext(
  resolution: MultiRepoResolution,
  clonedRepos: ClonedExternalRepo[],
  analysis: MultiRepoAnalysis
): MultiRepoContext {
  const reviewContext = buildReviewContextSection(analysis, resolution);
  const validatorContext = buildValidatorContextSection(analysis);
  const analysisSummary = buildAnalysisSummary(analysis, resolution, clonedRepos);
  const tokenCount = Math.ceil((reviewContext.length + validatorContext.length) / 4);

  return {
    enabled: true,
    reviewContext,
    validatorContext,
    staticFindings: analysis.findings,
    repoPathMap: analysis.repoPathMap,
    analysisSummary,
    unmappedImports: resolution.unmappedImports,
    knowledgeBase: analysis.knowledgeBase,
    tokenCount,
  };
}

/**
 * Return a disabled/empty multi-repo context for when the feature is off
 * or no cross-repo dependencies were detected.
 */
export function emptyMultiRepoContext(): MultiRepoContext {
  return {
    enabled: false,
    reviewContext: "",
    validatorContext: "",
    staticFindings: [],
    repoPathMap: new Map(),
    analysisSummary: "",
    unmappedImports: [],
    tokenCount: 0,
  };
}

/**
 * Query cross-repository knowledge for specific facts with strict source attribution,
 * token budgeting, and project isolation.
 */
export function queryProjectKnowledge(
  query: string,
  workingRepoSlug: string,
  ctx: MultiRepoContext,
  targetProjectId?: string
): CrossRepoFactQueryResult {
  if (!ctx.enabled || !ctx.knowledgeBase) {
    return {
      query,
      facts: [],
      formattedAnswer: "UNKNOWN: Multi-repo knowledge base is not initialized or disabled.",
      unknownFacts: ["all"],
    };
  }
  return queryCrossRepoKnowledge(query, workingRepoSlug, ctx.knowledgeBase, targetProjectId);
}

/**
 * Convert P1-XREPO-* cross-repo static findings into ValidatedFindings,
 * mirroring the pattern used for P1-STATIC-* Java import findings.
 *
 * Cross-repo findings are deterministic: they've been verified against the
 * actual external repo contents, so they bypass the LLM validator and are
 * automatically CONFIRMED.
 */
export function promoteXRepoFindings(findings: FindingCard[]): ValidatedFinding[] {
  return findings.map((finding) => {
    const key = `${finding.filePath}|${finding.severity}|${finding.rootCause.slice(0, 100)}`;
    const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

    return {
      ...finding,
      verdict: "CONFIRMED" as const,
      mergeBlocking: true,
      confidence: "HIGH" as const,
      validatorReasoning: finding.title.includes("Breaking change")
        ? `Cross-repo static analysis: symbol "${finding.title.match(/"([^"]+)"/)?.[1] || "unknown"}" ` +
          `is consumed by an external repository but was removed/modified in this PR.`
        : `Cross-repo static analysis: symbol "${finding.title.match(/"([^"]+)"/)?.[1] || "unknown"}" ` +
          `was verified against the external repository's actual exports and was not found.`,
      hash,
    };
  });
}
