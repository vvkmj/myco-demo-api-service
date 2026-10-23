// ─────────────────────────────────────────────────────────────────────────────
// Normalized requirement connector types
//
// Each connector (Jira, Confluence, GitHub docs, external URLs) produces
// NormalizedRequirement objects. The PRD validator consumes them to assess
// whether a PR satisfies its mandatory requirements.
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectorSource = "jira" | "confluence" | "github_docs" | "external_url" | "local_file";

export type RequirementPriority = "critical" | "high" | "medium" | "low" | "unknown";
export type RequirementSeverity = "mandatory" | "recommended" | "optional" | "unknown";

export type ValidationStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface NormalizedRequirement {
  /** Unique identifier — e.g. "REQ-1", "PROJ-123-AC-2", "CONF-42-REQ-1" */
  id: string;
  /** Source connector type */
  source: ConnectorSource;
  /** Human-readable description of the requirement */
  description: string;
  /** Acceptance criteria extracted from the requirement */
  acceptanceCriteria: string[];
  /** Priority from the source system */
  priority: RequirementPriority;
  /** Whether this requirement is mandatory for merge */
  severity: RequirementSeverity;
  /** URL back to the original source (Jira issue, Confluence page, etc.) */
  sourceUrl?: string;
  /** Version or last-updated timestamp from the source, when available */
  version?: string;
  /** Traceability links to related artifacts */
  traceability: TraceabilityLink[];
  /** Raw title from the source */
  title: string;
  /** The source document or ticket key */
  sourceKey: string;
  /** Content excerpt for LLM context (capped) */
  contentExcerpt: string;
}

export interface TraceabilityLink {
  type: "jira_issue" | "confluence_page" | "github_pr" | "github_issue" | "external_doc" | "code_file";
  id: string;
  url?: string;
  title?: string;
}

export interface RequirementValidationResult {
  requirement: NormalizedRequirement;
  status: ValidationStatus;
  /** Evidence supporting the status */
  evidence: string;
  /** Code locations relevant to this requirement */
  codeLocations: string[];
  /** Missing functionality, if status is FAIL */
  missingFunctionality?: string;
  /** Why validation couldn't be completed, if status is INCONCLUSIVE */
  inconclusiveReason?: string;
}

export interface ConnectorConfig {
  /** Jira Cloud base URL (e.g. https://myorg.atlassian.net) */
  jiraBaseUrl?: string;
  /** Jira API token — read from env, never logged */
  jiraToken?: string;
  /** Jira email for Basic auth */
  jiraEmail?: string;
  /** Jira project key(s) to scope queries */
  jiraProjects?: string[];

  /** Confluence Cloud base URL */
  confluenceBaseUrl?: string;
  /** Confluence API token — read from env, never logged */
  confluenceToken?: string;
  /** Confluence email for Basic auth */
  confluenceEmail?: string;
  /** Confluence space key(s) */
  confluenceSpaces?: string[];

  /** GitHub token for doc fetching */
  githubToken?: string;

  /** External document URLs to fetch */
  externalDocUrls?: string[];

  /** Request timeout in ms */
  timeoutMs?: number;

  /** Local repository path to scan */
  repoPath?: string;
}

export interface ConnectorResult {
  source: ConnectorSource;
  requirements: NormalizedRequirement[];
  /** Whether the connector successfully retrieved its data */
  success: boolean;
  /** Error message if retrieval failed */
  error?: string;
  /** Whether credentials were missing */
  credentialsMissing?: boolean;
  /** Whether the source was unreachable */
  sourceUnreachable?: boolean;
  /** Diagnostic messages for the report */
  diagnostics: string[];
}

/** Interface that all requirement connectors must implement */
export interface RequirementConnector {
  /** Human-readable connector name */
  readonly name: string;
  /** Source type identifier */
  readonly source: ConnectorSource;
  /** Whether this connector is configured (has required credentials/config) */
  isConfigured(): boolean;
  /** Fetch requirements from the source */
  fetch(config: ConnectorConfig): Promise<ConnectorResult>;
}
