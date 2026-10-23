// ─────────────────────────────────────────────────────────────────────────────
// Requirement and Jira Types for Myco Requirement Intelligence Engine
// ─────────────────────────────────────────────────────────────────────────────

export type RequirementSourceType = "doc" | "jira" | "spec" | "contract" | "pr_intent";

export interface RequirementItem {
  id: string; // e.g., "REQ-1", "PROJ-123", "AC-1"
  title: string;
  sourceFile: string;
  sourceType: RequirementSourceType;
  category?: "functional" | "non_functional" | "acceptance_criteria" | "constraint" | "scope" | "out_of_scope";
  content: string;
  acceptanceCriteria?: string[];
  scope?: {
    inScope: string[];
    outOfScope: string[];
  };
}

export interface JiraTicketDetail {
  key: string; // e.g. "PROJ-123", "JIRA-42"
  summary: string;
  description: string;
  issueType?: string; // "Story", "Bug", "Task", "Epic"
  status?: string;
  priority?: string;
  acceptanceCriteria: string[];
  filePath: string;
}

export interface RequirementDocument {
  filePath: string;
  fileName: string;
  docType: "markdown_doc" | "jira_ticket" | "jira_export" | "openapi_spec" | "text_spec";
  title: string;
  rawContent: string;
  summary: string;
  requirements: RequirementItem[];
  jiraTickets?: JiraTicketDetail[];
}

export interface RequirementChangeAnalysis {
  hasRequirementChanges: boolean;
  modifiedRequirementFiles: string[];
  addedRequirements: string[];
  modifiedRequirements: string[];
  removedRequirements: string[];
  codeFilesTouched: string[];
  summary: string;
}

export interface RequirementContext {
  enabled: boolean;
  documents: RequirementDocument[];
  allRequirements: RequirementItem[];
  jiraTickets: JiraTicketDetail[];
  changeAnalysis: RequirementChangeAnalysis;
  promptContext: string;
  validatorContext: string;
}
