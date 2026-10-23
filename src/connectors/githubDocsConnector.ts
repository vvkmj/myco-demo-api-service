import axios from "axios";
import {
  RequirementConnector,
  ConnectorConfig,
  ConnectorResult,
  NormalizedRequirement,
  RequirementPriority,
  RequirementSeverity,
  TraceabilityLink,
} from "./types";
import { extractJiraKeys } from "../requirements/requirementScanner";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Repository Documentation Connector
//
// Fetches PRD and design documents directly from GitHub repo via REST API.
// ─────────────────────────────────────────────────────────────────────────────

export class GithubDocsConnector implements RequirementConnector {
  readonly name = "GitHub Repository Documentation";
  readonly source = "github_docs" as const;

  private owner?: string;
  private repo?: string;

  constructor(owner?: string, repo?: string) {
    this.owner = owner;
    this.repo = repo;
  }

  isConfigured(): boolean {
    return !!(process.env.GITHUB_TOKEN || process.env.REPO_OWNER);
  }

  async fetch(config: ConnectorConfig): Promise<ConnectorResult> {
    const diagnostics: string[] = [];
    const requirements: NormalizedRequirement[] = [];
    const token = config.githubToken || process.env.GITHUB_TOKEN;

    const owner = this.owner || process.env.REPO_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
    const repo = this.repo || process.env.REPO_NAME;

    if (!owner || !repo) {
      diagnostics.push("GithubDocsConnector: owner/repo not configured — skipping remote fetch");
      return {
        source: this.source,
        requirements: [],
        success: true,
        diagnostics,
      };
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Myco-PRD-Validator",
    };
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    const docPaths = ["docs/PRD.md", "docs/requirements.md", "PRD.md", ".github/requirements.md"];

    for (const docPath of docPaths) {
      try {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${docPath}`;
        const res = await axios.get(url, { headers, timeout: config.timeoutMs || 10000 });
        if (res.status === 200 && res.data.content) {
          const content = Buffer.from(res.data.content, "base64").toString("utf-8");
          diagnostics.push(`GithubDocsConnector: found remote doc ${docPath}`);

          const req = this.parseDocContent(docPath, content, res.data.html_url, res.data.sha);
          if (req) requirements.push(req);
        }
      } catch (err: any) {
        // 404 is normal if file doesn't exist
        if (err.response?.status !== 404) {
          diagnostics.push(`GithubDocsConnector: error fetching ${docPath}: ${err.message}`);
        }
      }
    }

    return {
      source: this.source,
      requirements,
      success: true,
      diagnostics,
    };
  }

  private parseDocContent(
    filePath: string,
    content: string,
    htmlUrl: string,
    sha: string
  ): NormalizedRequirement | null {
    const lines = content.split("\n");
    let title = filePath;
    for (const line of lines.slice(0, 10)) {
      if (line.startsWith("# ")) {
        title = line.replace("# ", "").trim();
        break;
      }
    }

    const acceptanceCriteria: string[] = [];
    let inAcSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#{1,3}\s*(acceptance\s*criteria|requirements|specifications)\b/i.test(trimmed)) {
        inAcSection = true;
        continue;
      }
      if (inAcSection && /^#{1,3}\s+/.test(trimmed)) {
        inAcSection = false;
      }
      const match = trimmed.match(/^[-*]\s*(\[[ xX]\]\s*)?(.+)$/);
      if (inAcSection && match) {
        acceptanceCriteria.push(match[2].trim());
      }
    }

    const jiraKeys = extractJiraKeys(content);
    const traceability: TraceabilityLink[] = jiraKeys.map((key) => ({
      type: "jira_issue",
      id: key,
      title: `Linked Jira issue ${key}`,
    }));

    return {
      id: `GH-DOC-${filePath.replace(/[^a-zA-Z0-9]/g, "_")}`,
      source: "github_docs",
      title,
      description: content.slice(0, 2000),
      acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : [title],
      priority: "high",
      severity: "mandatory",
      sourceUrl: htmlUrl,
      version: sha,
      traceability,
      sourceKey: filePath,
      contentExcerpt: content.slice(0, 1500),
    };
  }
}
