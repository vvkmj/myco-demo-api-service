import axios, { AxiosInstance } from "axios";
import {
  RequirementConnector,
  ConnectorConfig,
  ConnectorResult,
  NormalizedRequirement,
  TraceabilityLink,
  RequirementPriority,
  RequirementSeverity,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Jira Cloud REST API v3 connector
//
// Reads issues, acceptance criteria, and linked requirements from Jira.
// Auth follows the same patterns as ticketCreator.ts (Basic/Bearer).
// Credentials are NEVER logged, exposed, or sent to the LLM.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESULTS_PER_PAGE = 50;
const MAX_PAGES = 5; // Safety cap: 250 issues max
const MAX_DESCRIPTION_CHARS = 3000;

/** Map Jira priority names to our normalized priority */
function mapJiraPriority(priority?: string): RequirementPriority {
  if (!priority) return "unknown";
  const lower = priority.toLowerCase();
  if (lower === "highest" || lower === "blocker" || lower === "critical") return "critical";
  if (lower === "high") return "high";
  if (lower === "medium" || lower === "normal") return "medium";
  if (lower === "low" || lower === "lowest" || lower === "trivial") return "low";
  return "unknown";
}

/** Map Jira issue type to requirement severity */
function mapJiraSeverity(issueType?: string): RequirementSeverity {
  if (!issueType) return "unknown";
  const lower = issueType.toLowerCase();
  if (lower === "bug" || lower === "security" || lower === "blocker") return "mandatory";
  if (lower === "story" || lower === "task" || lower === "requirement") return "mandatory";
  if (lower === "improvement" || lower === "enhancement") return "recommended";
  if (lower === "subtask" || lower === "sub-task") return "optional";
  return "unknown";
}

/** Extract plain text from Jira ADF (Atlassian Document Format) */
function extractAdfText(adf: any): string {
  if (!adf || typeof adf !== "object") return typeof adf === "string" ? adf : "";
  if (adf.type === "text") return adf.text || "";
  if (Array.isArray(adf.content)) {
    return adf.content.map(extractAdfText).join("");
  }
  return "";
}

/** Extract acceptance criteria from description text */
function extractAcceptanceCriteria(text: string): string[] {
  const criteria: string[] = [];
  const lines = text.split("\n");
  let inAcSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#{1,4}\s*(acceptance\s*criteria|ac|verification\s*criteria|definition\s*of\s*done)\b/i.test(trimmed)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && /^#{1,4}\s+[A-Za-z]/.test(trimmed)) {
      inAcSection = false;
    }

    const checkboxMatch = trimmed.match(/^[-*]\s*\[[ xX]\]\s*(.+)$/);
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim());
      continue;
    }

    if (inAcSection && /^[-*•\d+.]\s+(.+)$/.test(trimmed)) {
      const item = trimmed.replace(/^[-*•\d+.]\s+/, "").trim();
      if (item.length > 5) criteria.push(item);
    }
  }

  return criteria;
}

export class JiraConnector implements RequirementConnector {
  readonly name = "Jira Cloud";
  readonly source = "jira" as const;

  private config: ConnectorConfig = {};

  isConfigured(): boolean {
    return !!(
      (process.env.JIRA_BASE_URL || this.config.jiraBaseUrl) &&
      (process.env.JIRA_TOKEN || this.config.jiraToken)
    );
  }

  private buildAuthHeader(config: ConnectorConfig): string | null {
    const token = process.env.JIRA_TOKEN || config.jiraToken;
    const email = process.env.JIRA_EMAIL || config.jiraEmail;

    if (!token) return null;

    if (token.startsWith("Basic ") || token.startsWith("Bearer ")) {
      return token;
    }
    if (email) {
      return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    }
    if (token.includes(":")) {
      return `Basic ${Buffer.from(token).toString("base64")}`;
    }
    // Bare token — try Bearer (Jira Data Center PAT)
    return `Bearer ${token}`;
  }

  private createClient(config: ConnectorConfig): { client: AxiosInstance; baseUrl: string } | null {
    const baseUrl = (process.env.JIRA_BASE_URL || config.jiraBaseUrl || "").replace(/\/$/, "");
    const authHeader = this.buildAuthHeader(config);

    if (!baseUrl || !authHeader) return null;

    const client = axios.create({
      baseURL: baseUrl,
      timeout: config.timeoutMs || 15000,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    return { client, baseUrl };
  }

  async fetch(config: ConnectorConfig): Promise<ConnectorResult> {
    this.config = config;
    const diagnostics: string[] = [];
    const requirements: NormalizedRequirement[] = [];

    if (!this.isConfigured()) {
      return {
        source: this.source,
        requirements: [],
        success: false,
        credentialsMissing: true,
        error: "Jira credentials not configured. Set JIRA_BASE_URL and JIRA_TOKEN.",
        diagnostics: ["Jira connector: credentials missing — marking validation as INCONCLUSIVE for Jira requirements"],
      };
    }

    const setup = this.createClient(config);
    if (!setup) {
      return {
        source: this.source,
        requirements: [],
        success: false,
        credentialsMissing: true,
        error: "Failed to create Jira client — check JIRA_BASE_URL and JIRA_TOKEN",
        diagnostics: ["Jira connector: client creation failed"],
      };
    }

    const { client, baseUrl } = setup;
    const projects = config.jiraProjects || (process.env.JIRA_PROJECT ? [process.env.JIRA_PROJECT] : []);

    try {
      // Test authentication first
      try {
        await client.get("/rest/api/3/myself");
        diagnostics.push("Jira connector: authentication successful");
      } catch (authErr: any) {
        const status = authErr.response?.status;
        if (status === 401) {
          return {
            source: this.source,
            requirements: [],
            success: false,
            error: "Jira authentication failed (401 Unauthorized). Check JIRA_TOKEN and JIRA_EMAIL.",
            diagnostics: ["Jira connector: authentication failed (401) — token may be expired or invalid"],
          };
        }
        if (status === 403) {
          return {
            source: this.source,
            requirements: [],
            success: false,
            error: "Jira access forbidden (403). Token may lack read permissions.",
            diagnostics: ["Jira connector: access forbidden (403) — insufficient permissions"],
          };
        }
        // Network error
        return {
          source: this.source,
          requirements: [],
          success: false,
          sourceUnreachable: true,
          error: `Jira unreachable: ${authErr.message}`,
          diagnostics: [`Jira connector: unreachable — ${authErr.message}`],
        };
      }

      // Fetch issues from configured projects
      for (const project of projects) {
        let startAt = 0;
        let pageCount = 0;

        while (pageCount < MAX_PAGES) {
          const jql = `project = "${project}" AND statusCategory != Done ORDER BY priority DESC, updated DESC`;

          try {
            const res = await client.get("/rest/api/3/search", {
              params: {
                jql,
                startAt,
                maxResults: MAX_RESULTS_PER_PAGE,
                fields: "summary,description,issuetype,status,priority,labels,issuelinks,customfield_10020",
              },
            });

            const issues = res.data.issues || [];
            if (issues.length === 0) break;

            for (const issue of issues) {
              const req = this.normalizeIssue(issue, baseUrl);
              if (req) requirements.push(req);
            }

            diagnostics.push(`Jira connector: fetched ${issues.length} issue(s) from ${project} (page ${pageCount + 1})`);

            if (issues.length < MAX_RESULTS_PER_PAGE) break;
            startAt += MAX_RESULTS_PER_PAGE;
            pageCount++;
          } catch (err: any) {
            if (err.response?.status === 429) {
              diagnostics.push(`Jira connector: rate limited on project ${project} — stopping pagination`);
              break;
            }
            diagnostics.push(`Jira connector: error fetching ${project}: ${err.message}`);
            break;
          }
        }
      }

      // If no projects configured, try fetching specific issues from PR context
      if (projects.length === 0) {
        diagnostics.push("Jira connector: no JIRA_PROJECT configured — skipping project-scoped search");
      }

      return {
        source: this.source,
        requirements,
        success: true,
        diagnostics,
      };
    } catch (err: any) {
      return {
        source: this.source,
        requirements,
        success: false,
        error: `Jira connector error: ${err.message}`,
        diagnostics: [...diagnostics, `Jira connector: unexpected error — ${err.message}`],
      };
    }
  }

  /** Fetch a single Jira issue by key (e.g. "PROJ-123") */
  async fetchIssue(issueKey: string, config: ConnectorConfig): Promise<NormalizedRequirement | null> {
    const setup = this.createClient(config);
    if (!setup) return null;

    try {
      const res = await setup.client.get(`/rest/api/3/issue/${issueKey}`, {
        params: {
          fields: "summary,description,issuetype,status,priority,labels,issuelinks",
        },
      });
      return this.normalizeIssue(res.data, setup.baseUrl);
    } catch {
      return null;
    }
  }

  private normalizeIssue(issue: any, baseUrl: string): NormalizedRequirement | null {
    if (!issue?.key) return null;

    const fields = issue.fields || {};
    const summary = fields.summary || "Untitled";
    const rawDescription = fields.description;

    let descriptionText: string;
    if (typeof rawDescription === "string") {
      descriptionText = rawDescription;
    } else if (rawDescription && typeof rawDescription === "object") {
      descriptionText = extractAdfText(rawDescription);
    } else {
      descriptionText = "";
    }

    const acceptanceCriteria = extractAcceptanceCriteria(descriptionText);
    const issueType = fields.issuetype?.name || "Task";
    const priority = fields.priority?.name;
    const sourceUrl = `${baseUrl}/browse/${issue.key}`;

    // Build traceability links from Jira issue links
    const traceability: TraceabilityLink[] = [];
    if (Array.isArray(fields.issuelinks)) {
      for (const link of fields.issuelinks) {
        const linked = link.outwardIssue || link.inwardIssue;
        if (linked?.key) {
          traceability.push({
            type: "jira_issue",
            id: linked.key,
            url: `${baseUrl}/browse/${linked.key}`,
            title: linked.fields?.summary,
          });
        }
      }
    }

    return {
      id: issue.key,
      source: "jira",
      title: summary,
      description: `[${issue.key}] ${summary}\nType: ${issueType}\nStatus: ${fields.status?.name || "Unknown"}\nPriority: ${priority || "Unknown"}\n\n${descriptionText.slice(0, MAX_DESCRIPTION_CHARS)}`,
      acceptanceCriteria,
      priority: mapJiraPriority(priority),
      severity: mapJiraSeverity(issueType),
      sourceUrl,
      version: fields.updated || fields.created,
      traceability,
      sourceKey: issue.key,
      contentExcerpt: descriptionText.slice(0, 2000),
    };
  }
}
