import {
  ConnectorConfig,
  ConnectorResult,
  NormalizedRequirement,
  RequirementConnector,
} from "./types";
import { JiraConnector } from "./jiraConnector";
import { ConfluenceConnector } from "./confluenceConnector";
import { ExternalDocConnector } from "./externalDocConnector";
import { LocalRepoConnector } from "./localRepoConnector";
import { GithubDocsConnector } from "./githubDocsConnector";

// ─────────────────────────────────────────────────────────────────────────────
// Connector registry — orchestrates all requirement source connectors
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorOrchestratorResult {
  /** All normalized requirements from all sources */
  allRequirements: NormalizedRequirement[];
  /** Per-connector results for diagnostics */
  connectorResults: ConnectorResult[];
  /** Human-readable summary of connector execution */
  summary: string;
  /** Whether any connector had missing credentials (affects merge policy) */
  hasCredentialGaps: boolean;
  /** Whether any source was unreachable */
  hasUnreachableSources: boolean;
  /** All diagnostic messages combined */
  allDiagnostics: string[];
}

/** Build ConnectorConfig from environment variables */
export function buildConnectorConfig(repoPath?: string): ConnectorConfig {
  return {
    jiraBaseUrl: process.env.JIRA_BASE_URL,
    jiraToken: process.env.JIRA_TOKEN,
    jiraEmail: process.env.JIRA_EMAIL,
    jiraProjects: process.env.JIRA_PROJECT
      ? process.env.JIRA_PROJECT.split(",").map(s => s.trim()).filter(Boolean)
      : [],
    confluenceBaseUrl: process.env.CONFLUENCE_BASE_URL,
    confluenceToken: process.env.CONFLUENCE_TOKEN,
    confluenceEmail: process.env.CONFLUENCE_EMAIL,
    confluenceSpaces: process.env.CONFLUENCE_SPACE
      ? process.env.CONFLUENCE_SPACE.split(",").map(s => s.trim()).filter(Boolean)
      : [],
    githubToken: process.env.GITHUB_TOKEN,
    externalDocUrls: process.env.PRD_URLS
      ? process.env.PRD_URLS.split(",").map(s => s.trim()).filter(Boolean)
      : [],
    timeoutMs: process.env.CONNECTOR_TIMEOUT_MS
      ? parseInt(process.env.CONNECTOR_TIMEOUT_MS, 10)
      : 15000,
    repoPath: repoPath || process.cwd(),
  };
}

/** Get all registered connectors */
export function getConnectors(repoPath?: string): RequirementConnector[] {
  return [
    new LocalRepoConnector(repoPath),
    new JiraConnector(),
    new ConfluenceConnector(),
    new ExternalDocConnector(),
    new GithubDocsConnector(),
  ];
}

/**
 * Orchestrate all configured connectors to fetch requirements.
 *
 * Runs configured connectors in parallel. Each connector independently
 * reports its success/failure and diagnostics. Missing credentials are
 * reported clearly — they do NOT cause a silent pass.
 */
export async function fetchAllRequirements(
  config?: ConnectorConfig
): Promise<ConnectorOrchestratorResult> {
  const cfg = config || buildConnectorConfig();
  const connectors = getConnectors(cfg.repoPath);
  const allDiagnostics: string[] = [];

  // Check which connectors are enabled/configured
  const enabledConnectors = connectors.filter(c => {
    const enabled = c.isConfigured();
    if (!enabled) {
      allDiagnostics.push(`${c.name}: not configured — skipping`);
    }
    return enabled;
  });

  // Also include unconfigured connectors if their env vars suggest intent
  // (e.g. JIRA_BASE_URL is set but JIRA_TOKEN is missing)
  const intentConnectors = connectors.filter(c => {
    if (enabledConnectors.includes(c)) return false;
    // Check if partial config exists
    if (c.source === "jira" && process.env.JIRA_BASE_URL) return true;
    if (c.source === "confluence" && process.env.CONFLUENCE_BASE_URL) return true;
    return false;
  });

  const toRun = [...enabledConnectors, ...intentConnectors];

  if (toRun.length === 0) {
    return {
      allRequirements: [],
      connectorResults: [],
      summary: "No requirement connectors configured.",
      hasCredentialGaps: false,
      hasUnreachableSources: false,
      allDiagnostics,
    };
  }

  // Run connectors in parallel
  const results = await Promise.all(
    toRun.map(async (connector): Promise<ConnectorResult> => {
      try {
        console.log(`  📡  Fetching requirements from ${connector.name}...`);
        return await connector.fetch(cfg);
      } catch (err: any) {
        return {
          source: connector.source,
          requirements: [],
          success: false,
          error: err.message || "Unknown error",
          diagnostics: [`${connector.name}: unhandled error: ${err.message}`],
        };
      }
    })
  );

  // Aggregate results
  const allRequirements: NormalizedRequirement[] = [];
  const seenIds = new Set<string>();
  let hasCredentialGaps = false;
  let hasUnreachableSources = false;

  for (const r of results) {
    for (const req of r.requirements) {
      if (!seenIds.has(req.id)) {
        seenIds.add(req.id);
        allRequirements.push(req);
      }
    }
    if (r.credentialsMissing) hasCredentialGaps = true;
    if (r.sourceUnreachable) hasUnreachableSources = true;
    allDiagnostics.push(...r.diagnostics);
  }

  // Build human-readable summary
  const summaryParts: string[] = [];
  for (const r of results) {
    const status = r.success
      ? `✅ ${r.requirements.length} requirement(s)`
      : r.credentialsMissing
      ? `🔒 Credentials missing`
      : r.sourceUnreachable
      ? `🌐 Source unreachable`
      : `❌ Failed: ${r.error}`;
    summaryParts.push(`${r.source}: ${status}`);
  }

  return {
    allRequirements,
    connectorResults: results,
    summary: summaryParts.join(" | "),
    hasCredentialGaps,
    hasUnreachableSources,
    allDiagnostics,
  };
}
