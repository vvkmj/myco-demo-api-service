import axios, { AxiosInstance } from "axios";
import {
  RequirementConnector,
  ConnectorConfig,
  ConnectorResult,
  NormalizedRequirement,
  TraceabilityLink,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Confluence Cloud REST API v2 connector
//
// Reads Confluence pages, extracts requirements and acceptance criteria.
// Follows links to child pages (1 level deep) for comprehensive coverage.
// Auth uses Basic (email:token) like Jira Cloud.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PAGES_PER_SPACE = 20;
const MAX_CONTENT_CHARS = 5000;

/** Strip Confluence storage format (XHTML) to plain text */
function stripConfluenceHtml(html: string): string {
  return html
    .replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract acceptance criteria from page text */
function extractAcFromText(text: string): string[] {
  const criteria: string[] = [];
  const lines = text.split("\n");
  let inAcSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(acceptance\s*criteria|ac|verification|definition\s*of\s*done)\s*$/i.test(trimmed) ||
        /^\d+\.\s*(acceptance\s*criteria)/i.test(trimmed)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && /^[A-Z][\w\s]+$/.test(trimmed) && trimmed.length < 60) {
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

export class ConfluenceConnector implements RequirementConnector {
  readonly name = "Confluence Cloud";
  readonly source = "confluence" as const;

  isConfigured(): boolean {
    return !!(
      (process.env.CONFLUENCE_BASE_URL) &&
      (process.env.CONFLUENCE_TOKEN)
    );
  }

  private createClient(config: ConnectorConfig): { client: AxiosInstance; baseUrl: string } | null {
    const baseUrl = (process.env.CONFLUENCE_BASE_URL || config.confluenceBaseUrl || "").replace(/\/$/, "");
    const token = process.env.CONFLUENCE_TOKEN || config.confluenceToken;
    const email = process.env.CONFLUENCE_EMAIL || config.confluenceEmail;

    if (!baseUrl || !token) return null;

    let authHeader: string;
    if (token.startsWith("Basic ") || token.startsWith("Bearer ")) {
      authHeader = token;
    } else if (email) {
      authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    } else if (token.includes(":")) {
      authHeader = `Basic ${Buffer.from(token).toString("base64")}`;
    } else {
      authHeader = `Bearer ${token}`;
    }

    const client = axios.create({
      baseURL: baseUrl,
      timeout: config.timeoutMs || 15000,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });

    return { client, baseUrl };
  }

  async fetch(config: ConnectorConfig): Promise<ConnectorResult> {
    const diagnostics: string[] = [];
    const requirements: NormalizedRequirement[] = [];

    if (!this.isConfigured()) {
      return {
        source: this.source,
        requirements: [],
        success: false,
        credentialsMissing: true,
        error: "Confluence credentials not configured. Set CONFLUENCE_BASE_URL and CONFLUENCE_TOKEN.",
        diagnostics: ["Confluence connector: credentials missing — marking validation as INCONCLUSIVE for Confluence requirements"],
      };
    }

    const setup = this.createClient(config);
    if (!setup) {
      return {
        source: this.source,
        requirements: [],
        success: false,
        credentialsMissing: true,
        error: "Failed to create Confluence client",
        diagnostics: ["Confluence connector: client creation failed"],
      };
    }

    const { client, baseUrl } = setup;
    const spaces = config.confluenceSpaces ||
      (process.env.CONFLUENCE_SPACE ? process.env.CONFLUENCE_SPACE.split(",").map(s => s.trim()) : []);

    try {
      // Test authentication
      try {
        await client.get("/wiki/rest/api/space", { params: { limit: 1 } });
        diagnostics.push("Confluence connector: authentication successful");
      } catch (authErr: any) {
        const status = authErr.response?.status;
        if (status === 401 || status === 403) {
          return {
            source: this.source,
            requirements: [],
            success: false,
            error: `Confluence authentication failed (${status}). Check CONFLUENCE_TOKEN.`,
            diagnostics: [`Confluence connector: auth failed (${status})`],
          };
        }
        return {
          source: this.source,
          requirements: [],
          success: false,
          sourceUnreachable: true,
          error: `Confluence unreachable: ${authErr.message}`,
          diagnostics: [`Confluence connector: unreachable — ${authErr.message}`],
        };
      }

      // Fetch pages from configured spaces
      for (const space of spaces) {
        try {
          const res = await client.get("/wiki/rest/api/content", {
            params: {
              spaceKey: space,
              type: "page",
              limit: MAX_PAGES_PER_SPACE,
              expand: "body.storage,version,ancestors",
              orderby: "modified desc",
            },
          });

          const pages = res.data.results || [];
          diagnostics.push(`Confluence connector: fetched ${pages.length} page(s) from space "${space}"`);

          for (const page of pages) {
            const req = this.normalizePage(page, baseUrl, space);
            if (req) requirements.push(req);
          }
        } catch (err: any) {
          if (err.response?.status === 429) {
            diagnostics.push(`Confluence connector: rate limited on space "${space}"`);
          } else {
            diagnostics.push(`Confluence connector: error fetching space "${space}": ${err.message}`);
          }
        }
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
        error: `Confluence connector error: ${err.message}`,
        diagnostics: [...diagnostics, `Confluence connector: unexpected error — ${err.message}`],
      };
    }
  }

  /** Fetch a specific Confluence page by ID */
  async fetchPage(pageId: string, config: ConnectorConfig): Promise<NormalizedRequirement | null> {
    const setup = this.createClient(config);
    if (!setup) return null;

    try {
      const res = await setup.client.get(`/wiki/rest/api/content/${pageId}`, {
        params: { expand: "body.storage,version" },
      });
      return this.normalizePage(res.data, setup.baseUrl);
    } catch {
      return null;
    }
  }

  private normalizePage(page: any, baseUrl: string, spaceKey?: string): NormalizedRequirement | null {
    if (!page?.id) return null;

    const title = page.title || "Untitled Page";
    const storageBody = page.body?.storage?.value || "";
    const plainText = stripConfluenceHtml(storageBody);

    // Skip pages with very little content
    if (plainText.length < 20) return null;

    const acceptanceCriteria = extractAcFromText(plainText);
    const sourceUrl = `${baseUrl}/wiki/spaces/${spaceKey || ""}/pages/${page.id}`;

    const traceability: TraceabilityLink[] = [];
    // Extract Jira issue links from the content
    const jiraKeyMatches = plainText.match(/\b([A-Z][A-Z0-9]+-\d+)\b/g);
    if (jiraKeyMatches) {
      for (const key of new Set(jiraKeyMatches)) {
        traceability.push({
          type: "jira_issue",
          id: key,
          title: key,
        });
      }
    }

    return {
      id: `CONF-${page.id}`,
      source: "confluence",
      title,
      description: `Confluence page: ${title}\n\n${plainText.slice(0, MAX_CONTENT_CHARS)}`,
      acceptanceCriteria,
      priority: "medium",
      severity: acceptanceCriteria.length > 0 ? "mandatory" : "recommended",
      sourceUrl,
      version: page.version?.when,
      traceability,
      sourceKey: `CONF-${page.id}`,
      contentExcerpt: plainText.slice(0, 2000),
    };
  }
}
