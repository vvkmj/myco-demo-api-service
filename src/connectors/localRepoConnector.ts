import * as fs from "fs";
import * as path from "path";
import {
  RequirementConnector,
  ConnectorConfig,
  ConnectorResult,
  NormalizedRequirement,
  RequirementPriority,
  RequirementSeverity,
  TraceabilityLink,
} from "./types";
import {
  scanFolderRequirements,
  extractJiraKeys,
  parseRequirementFile,
} from "../requirements/requirementScanner";
import { RequirementItem, JiraTicketDetail } from "../requirements/requirementTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Local Repository PRD & Specification Connector
//
// Extracts requirements from repository docs (docs/, specs/, PRD.md, etc.)
// and local Jira ticket exports. Produces NormalizedRequirement objects.
// ─────────────────────────────────────────────────────────────────────────────

export class LocalRepoConnector implements RequirementConnector {
  readonly name = "Local Repository PRD & Docs";
  readonly source = "local_file" as const;

  private repoPath: string;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();
  }

  isConfigured(): boolean {
    return true; // Local repo is always accessible if directory exists
  }

  async fetch(config: ConnectorConfig): Promise<ConnectorResult> {
    const diagnostics: string[] = [];
    const requirements: NormalizedRequirement[] = [];

    const targetDir = this.repoPath || process.cwd();
    diagnostics.push(`LocalRepoConnector: scanning directory "${targetDir}" for PRDs and specs`);

    try {
      const scanResult = scanFolderRequirements(targetDir, []);
      diagnostics.push(`LocalRepoConnector: found ${scanResult.documents.length} requirement document(s)`);

      for (const doc of scanResult.documents) {
        let docVersion: string | undefined;
        try {
          const stats = fs.statSync(doc.filePath);
          docVersion = stats.mtime.toISOString();
        } catch {
          // ignore stat failure
        }

        // Process requirement items
        for (const req of doc.requirements) {
          const normReq = this.normalizeItem(req, doc.filePath, docVersion);
          requirements.push(normReq);
        }

        // Process Jira ticket details if any
        if (doc.jiraTickets && doc.jiraTickets.length > 0) {
          for (const ticket of doc.jiraTickets) {
            const normTicket = this.normalizeJiraTicket(ticket, doc.filePath, docVersion);
            requirements.push(normTicket);
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
      diagnostics.push(`LocalRepoConnector error: ${err.message}`);
      return {
        source: this.source,
        requirements: [],
        success: false,
        error: err.message,
        diagnostics,
      };
    }
  }

  private normalizeItem(
    item: RequirementItem,
    filePath: string,
    version?: string
  ): NormalizedRequirement {
    const hasMandatoryAc = item.acceptanceCriteria && item.acceptanceCriteria.length > 0;
    const isMandatory =
      item.category === "acceptance_criteria" ||
      hasMandatoryAc ||
      /\b(must|required|mandatory|shall|critical)\b/i.test(item.content) ||
      /\b(acceptance criteria|ac)\b/i.test(item.title);

    const severity: RequirementSeverity = isMandatory ? "mandatory" : "recommended";

    const priority: RequirementPriority =
      /\b(blocker|critical|p0)\b/i.test(item.content) ? "critical" :
      /\b(high|p1)\b/i.test(item.content) ? "high" :
      /\b(medium|p2)\b/i.test(item.content) ? "medium" : "medium";

    const traceability: TraceabilityLink[] = [
      {
        type: "code_file",
        id: path.basename(filePath),
        url: filePath,
        title: item.title,
      },
    ];

    // Check for linked Jira keys in content
    const jiraKeys = extractJiraKeys(item.content);
    for (const key of jiraKeys) {
      traceability.push({
        type: "jira_issue",
        id: key,
        title: `Referenced Jira issue ${key}`,
      });
    }

    return {
      id: item.id,
      source: "local_file",
      title: item.title,
      description: item.content,
      acceptanceCriteria: item.acceptanceCriteria && item.acceptanceCriteria.length > 0
        ? item.acceptanceCriteria
        : [item.content],
      priority,
      severity,
      sourceUrl: filePath,
      version,
      traceability,
      sourceKey: path.basename(filePath),
      contentExcerpt: item.content.slice(0, 1500),
    };
  }

  private normalizeJiraTicket(
    ticket: JiraTicketDetail,
    filePath: string,
    version?: string
  ): NormalizedRequirement {
    const priority: RequirementPriority =
      ticket.priority?.toLowerCase() === "highest" || ticket.priority?.toLowerCase() === "blocker" ? "critical" :
      ticket.priority?.toLowerCase() === "high" ? "high" :
      ticket.priority?.toLowerCase() === "low" ? "low" : "medium";

    const isMandatory =
      ticket.issueType?.toLowerCase() === "bug" ||
      ticket.issueType?.toLowerCase() === "story" ||
      ticket.acceptanceCriteria.length > 0;

    return {
      id: ticket.key,
      source: "local_file",
      title: `${ticket.key}: ${ticket.summary}`,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria.length > 0
        ? ticket.acceptanceCriteria
        : [ticket.summary],
      priority,
      severity: isMandatory ? "mandatory" : "recommended",
      sourceUrl: filePath,
      version,
      traceability: [
        {
          type: "jira_issue",
          id: ticket.key,
          title: ticket.summary,
        },
      ],
      sourceKey: ticket.key,
      contentExcerpt: `${ticket.summary}\n${ticket.description}`.slice(0, 1500),
    };
  }
}
