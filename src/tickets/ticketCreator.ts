import axios from "axios";
import { ValidatedFinding } from "../validate/findingValidator";

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface TicketCreator {
  /**
   * Creates a ticket for the finding. Returns the ticket URL, or null for dry-run.
   * @param prAuthor  GitHub login of the PR author — used to assign the ticket if a
   *                  matching Jira user can be found.
   */
  create(finding: ValidatedFinding, prUrl: string, prAuthor?: string): Promise<string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Jira implementation
// ─────────────────────────────────────────────────────────────────────────────

export class JiraTicketCreator implements TicketCreator {
  private baseUrl: string;
  private authHeader: string;
  private project: string;
  private issueType: string;

  constructor() {
    const baseUrl = process.env.JIRA_BASE_URL;
    const token = process.env.JIRA_TOKEN;
    const email = process.env.JIRA_EMAIL;
    const project = process.env.JIRA_PROJECT;

    if (!baseUrl) throw new Error("Missing env var: JIRA_BASE_URL");
    if (!token) throw new Error("Missing env var: JIRA_TOKEN");
    if (!project) throw new Error("Missing env var: JIRA_PROJECT");

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.project = project;
    this.issueType = process.env.JIRA_ISSUE_TYPE || "Bug";

    if (token.startsWith("Basic ") || token.startsWith("Bearer ")) {
      // Already a fully formed auth header
      this.authHeader = token;
    } else if (email) {
      // Standard Atlassian Cloud auth: Basic base64(email:api-token)
      this.authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    } else if (token.includes(":")) {
      // JIRA_TOKEN stored as "email:api-token" directly
      this.authHeader = `Basic ${Buffer.from(token).toString("base64")}`;
    } else {
      // Bare token with no email — Atlassian Cloud requires Basic auth with an email.
      // Set JIRA_EMAIL or store JIRA_TOKEN as "email:api-token". Bearer only works
      // for Jira Data Center PATs, not Cloud API tokens.
      console.warn(
        "⚠️   JIRA_TOKEN looks like a bare API token but JIRA_EMAIL is not set. " +
        "Atlassian Cloud requires Basic auth. " +
        "Set JIRA_EMAIL or store JIRA_TOKEN as 'email@example.com:api-token'."
      );
      this.authHeader = `Bearer ${token}`;
    }
  }

  /**
   * Resolve a GitHub login to a Jira Cloud accountId via the user search API.
   * Returns null (and logs a warning) if no unique match is found.
   */
  private async resolveAssigneeAccountId(authorLogin: string): Promise<string | null> {
    try {
      const res = await axios.get(`${this.baseUrl}/rest/api/3/user/search`, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
        params: { query: authorLogin, maxResults: 10 },
      });

      const users: Array<{ accountId: string; displayName: string; emailAddress?: string }> =
        res.data ?? [];

      if (users.length === 0) {
        console.warn(
          `  ⚠️   Jira assignee lookup: no user found matching GitHub login "${authorLogin}" — ticket will be unassigned.`
        );
        return null;
      }

      // Only assign when we can identify the user unambiguously:
      //   - exactly one result, OR
      //   - an exact case-insensitive display-name match among multiple results.
      // If neither holds, leave the ticket unassigned rather than guessing.
      const exact = users.find(
        (u) => u.displayName.toLowerCase() === authorLogin.toLowerCase()
      );

      if (users.length === 1) {
        const match = users[0];
        console.log(`  👤  Jira assignee resolved: "${match.displayName}" (${match.accountId})`);
        return match.accountId;
      }

      if (exact) {
        console.log(`  👤  Jira assignee resolved: "${exact.displayName}" (${exact.accountId})`);
        return exact.accountId;
      }

      console.warn(
        `  ⚠️   Jira assignee lookup: ${users.length} users matched "${authorLogin}" but none matched exactly — ticket will be unassigned. ` +
        `Set JIRA_ASSIGNEE_ACCOUNT_ID to assign manually.`
      );
      return null;
    } catch (err: any) {
      console.warn(
        `  ⚠️   Jira assignee lookup failed for "${authorLogin}": ${err.message} — ticket will be unassigned.`
      );
      return null;
    }
  }

  async create(finding: ValidatedFinding, prUrl: string, prAuthor?: string): Promise<string | null> {
    const summary = `[${finding.id}] ${finding.title}`;

    const description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Root cause" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: finding.rootCause }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Impact" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: finding.impact }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Suggested fix" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: finding.fix }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Reasoning" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: finding.validatorReasoning }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Source" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "File: " },
            { type: "text", text: finding.file },
            { type: "hardBreak" },
            { type: "text", text: "PR: " },
            {
              type: "text",
              text: prUrl,
              marks: [{ type: "link", attrs: { href: prUrl } }],
            },
          ],
        },
      ],
    };

    const baseLabels = ["Zenith", "pr-reviewer-agent", "auto-generated", finding.severity.toLowerCase()];
    const extraLabels = (process.env.JIRA_LABELS || "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const labels = [...new Set([...baseLabels, ...extraLabels])];

    // Resolve assignee: prefer an explicit override env var, then look up the PR author.
    let assigneeAccountId: string | null = process.env.JIRA_ASSIGNEE_ACCOUNT_ID || null;
    if (!assigneeAccountId && prAuthor) {
      assigneeAccountId = await this.resolveAssigneeAccountId(prAuthor);
    }

    const payload: Record<string, any> = {
      fields: {
        project: { key: this.project },
        summary,
        description,
        issuetype: { name: this.issueType },
        labels,
        ...(assigneeAccountId ? { assignee: { id: assigneeAccountId } } : {}),
      },
    };

    const res = await axios.post(`${this.baseUrl}/rest/api/3/issue`, payload, {
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    const issueKey: string = res.data.key;
    return `${this.baseUrl}/browse/${issueKey}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run implementation
// ─────────────────────────────────────────────────────────────────────────────

export class DryRunTicketCreator implements TicketCreator {
  async create(finding: ValidatedFinding, prUrl: string, prAuthor?: string): Promise<string | null> {
    console.log(
      `  [dry-run] Would create Jira ticket:\n` +
      `    Summary:  [${finding.id}] ${finding.title}\n` +
      `    File:     ${finding.file}\n` +
      `    PR:       ${prUrl}\n` +
      `    Assignee: ${prAuthor ?? "(unassigned)"}\n` +
      `    Labels:   pr-reviewer, auto-generated, ${finding.severity.toLowerCase()}`
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTicketCreator(mode: "jira" | "dry-run"): TicketCreator {
  if (mode === "jira") return new JiraTicketCreator();
  return new DryRunTicketCreator();
}
