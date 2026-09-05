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

    // No hardcoded product name here on purpose — the name isn't finalized
    // yet, and a client-visible Jira label is exactly the kind of thing
    // that shouldn't leak an internal codename. PRODUCT_LABEL is the one
    // place to update once a name is picked; GitHubIssuesTicketCreator
    // below uses the same env var so both providers stay in sync.
    const productLabel = process.env.PRODUCT_LABEL || "ai-code-review";
    const baseLabels = [productLabel, "auto-generated", finding.severity.toLowerCase()];
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
// GitHub Issues implementation
//
// Uses the same GITHUB_TOKEN the workflow already has (via `permissions:`
// in the consumer's own workflow — requires `issues: write` in addition to
// the existing `contents: read` / `pull-requests: write`). No extra secret
// needed, which makes this the lowest-setup ticket provider for a
// self-serve client. Creates the issue in the same repo being reviewed
// (there's no token available for cross-repo writes without a separate
// GitHub App/PAT), primarily so confirmed-bug counts are queryable via the
// GitHub API for metrics (e.g. `is:issue label:<PRODUCT_LABEL>-confirmed-bug`)
// even when a client only wants inline PR comments as their visible UX.
// ─────────────────────────────────────────────────────────────────────────────

export class GitHubIssuesTicketCreator implements TicketCreator {
  private token: string;
  private owner: string;
  private repo: string;
  private labels: string[];
  private apiBase: string;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("Missing env var: GITHUB_TOKEN");

    // GITHUB_REPOSITORY ("owner/repo") is set automatically by GitHub Actions.
    // TICKET_GITHUB_REPO is an explicit override for non-Actions usage.
    const repoSlug = process.env.TICKET_GITHUB_REPO || process.env.GITHUB_REPOSITORY;
    if (!repoSlug || !repoSlug.includes("/")) {
      throw new Error(
        'Missing/invalid repo for GitHub Issues ticket creation — set TICKET_GITHUB_REPO ' +
        '("owner/repo") or run under GitHub Actions where GITHUB_REPOSITORY is set automatically.'
      );
    }
    const [owner, repo] = repoSlug.split("/");
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.apiBase = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

    const extraLabels = (process.env.GITHUB_ISSUE_LABELS || "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    // Per-finding severity label is added in create() since it isn't known here.
    // Same PRODUCT_LABEL env var as JiraTicketCreator — no hardcoded
    // codename in a client-visible label while the product name is still
    // being finalized (see comment on JiraTicketCreator's baseLabels).
    const productLabel = process.env.PRODUCT_LABEL || "ai-code-review";
    this.labels = [...new Set([`${productLabel}-confirmed-bug`, ...extraLabels])];
  }

  async create(finding: ValidatedFinding, prUrl: string, prAuthor?: string): Promise<string | null> {
    const title = `[${finding.id}] ${finding.title}`;
    const body = [
      `**Severity:** ${finding.severity}`,
      `**File:** ${finding.file}`,
      "",
      "### Root cause",
      finding.rootCause,
      "",
      "### Impact",
      finding.impact,
      "",
      "### Suggested fix",
      finding.fix,
      "",
      "### Validator reasoning",
      finding.validatorReasoning,
      "",
      `**PR:** ${prUrl}`,
      prAuthor ? `**PR author:** @${prAuthor}` : "",
      "",
      "_Filed automatically — used for tracking confirmed-bug counts, not necessarily assignment._",
    ]
      .filter((l) => l !== "")
      .join("\n");

    const labels = [...new Set([...this.labels, finding.severity.toLowerCase()])];

    const res = await axios.post(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/issues`,
      { title, body, labels },
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    return res.data.html_url as string;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Dry-run implementation
// ─────────────────────────────────────────────────────────────────────────────

export class DryRunTicketCreator implements TicketCreator {
  async create(finding: ValidatedFinding, prUrl: string, prAuthor?: string): Promise<string | null> {
    console.log(
      `  [dry-run] Would create ticket:\n` +
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

export function createTicketCreator(mode: "jira" | "github-issues" | "dry-run"): TicketCreator {
  if (mode === "jira") return new JiraTicketCreator();
  if (mode === "github-issues") return new GitHubIssuesTicketCreator();
  return new DryRunTicketCreator();
}
