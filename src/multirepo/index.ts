// ─────────────────────────────────────────────────────────────────────────────
// Multi-Repository Support — barrel export
//
// This module adds cross-repository dependency detection, cloning, analysis,
// and integration into the Myco PR review pipeline. It allows Myco to:
//
// 1. Detect when a PR imports symbols from external repositories
// 2. Clone those external repos securely
// 3. Verify import/export compatibility (broken imports → deterministic findings)
// 4. Check reverse dependencies (does the external repo depend on our exports?)
// 5. Inject cross-repo context into the LLM review and validator prompts
//
// Configuration:
//   MULTI_REPO_ENABLED=true       — enable multi-repo analysis
//   MULTI_REPO_MAP={"@scope/pkg":"owner/repo"}  — explicit import→repo mappings
//   MULTI_REPO_AUTO_DETECT=true   — auto-detect from package.json
//   MULTI_REPO_TOKENS={"owner/repo":"token"}    — per-repo auth tokens
//   MULTI_REPO_CLONE_PATH=./path  — override clone directory
// ─────────────────────────────────────────────────────────────────────────────

export {
  parseRepoMappings,
  parseDownstreamRepos,
  parseRepoTokens,
  resolveMultiRepoDependencies,
  type RepoMapping,
  type ExternalRepoDependency,
  type MultiRepoResolution,
} from "./multiRepoResolver";

export {
  cloneExternalRepos,
  cleanupExternalRepos,
  type ClonedExternalRepo,
} from "./multiRepoCloner";

export {
  analyzeMultiRepoDependencies,
  parseFunctionParams,
  extractCallArguments,
  parseInterfaceProperties,
  findConsumerCallSites,
  type MultiRepoAnalysis,
  type CrossRepoAnalysisResult,
  type ExternalExport,
  type ConsumerCallSite,
  type ModifiedExportInfo,
  type ParsedParam,
} from "./multiRepoAnalyser";

export {
  buildMultiRepoContext,
  emptyMultiRepoContext,
  promoteXRepoFindings,
  type MultiRepoContext,
} from "./multiRepoIntegration";
