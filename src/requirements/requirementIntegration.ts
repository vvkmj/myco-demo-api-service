import { ChangedFile } from "../github/prFetcher";
import { scanFolderRequirements } from "./requirementScanner";
import { analyzeRequirementChanges } from "./requirementChangeTracker";
import { RequirementContext, RequirementDocument, JiraTicketDetail } from "./requirementTypes";

/**
 * Builds the comprehensive requirement context for a target repository/folder and diff.
 */
export function buildRequirementContext(
  repoPath?: string,
  changedFiles: ChangedFile[] = [],
  prContextText: string = ""
): RequirementContext {
  if (!repoPath) {
    return emptyRequirementContext();
  }

  const scan = scanFolderRequirements(repoPath, changedFiles, prContextText);
  const changeAnalysis = analyzeRequirementChanges(changedFiles, scan.documents);

  const enabled = scan.documents.length > 0 || changeAnalysis.hasRequirementChanges;

  if (!enabled) {
    return emptyRequirementContext();
  }

  const promptContext = buildReviewContextSection(scan.documents, scan.jiraTickets, changeAnalysis);
  const validatorContext = buildValidatorContextSection(scan.documents, scan.jiraTickets, changeAnalysis);

  return {
    enabled: true,
    documents: scan.documents,
    allRequirements: scan.allRequirements,
    jiraTickets: scan.jiraTickets,
    changeAnalysis,
    promptContext,
    validatorContext,
  };
}

export function emptyRequirementContext(): RequirementContext {
  return {
    enabled: false,
    documents: [],
    allRequirements: [],
    jiraTickets: [],
    changeAnalysis: {
      hasRequirementChanges: false,
      modifiedRequirementFiles: [],
      addedRequirements: [],
      modifiedRequirements: [],
      removedRequirements: [],
      codeFilesTouched: [],
      summary: "",
    },
    promptContext: "",
    validatorContext: "",
  };
}

function buildReviewContextSection(
  documents: RequirementDocument[],
  jiraTickets: JiraTicketDetail[],
  changeAnalysis: any
): string {
  const parts: string[] = [
    `## Documented Requirements & Jira Context (from attached repo/folder docs)`,
    ``,
    `The following requirements and Jira specifications were discovered in the repository/folder. ` +
    `Evaluate all code changes strictly against these requirements.`,
    ``,
  ];

  if (changeAnalysis.summary) {
    parts.push(`### Requirement Change Analysis`);
    parts.push(changeAnalysis.summary);
    parts.push(``);
  }

  if (jiraTickets.length > 0) {
    parts.push(`### Attached Jira Tickets (${jiraTickets.length})`);
    for (const t of jiraTickets.slice(0, 10)) {
      parts.push(`#### [${t.key}] ${t.summary} (${t.issueType || "Ticket"}${t.status ? ` · ${t.status}` : ""})`);
      parts.push(`**File:** \`${t.filePath}\``);
      if (t.acceptanceCriteria.length > 0) {
        parts.push(`**Acceptance Criteria:**`);
        for (const ac of t.acceptanceCriteria) {
          parts.push(`- ${ac}`);
        }
      }
      parts.push(`**Description excerpt:**`);
      parts.push(t.description.slice(0, 1200));
      parts.push(``);
    }
  }

  const nonJiraDocs = documents.filter((d) => d.docType !== "jira_ticket" && d.docType !== "jira_export");
  if (nonJiraDocs.length > 0) {
    parts.push(`### Requirement & Specification Documents (${nonJiraDocs.length})`);
    for (const d of nonJiraDocs.slice(0, 8)) {
      parts.push(`#### ${d.title} (\`${d.filePath}\`)`);
      parts.push(`**Summary:** ${d.summary}`);
      const acList = d.requirements.flatMap((r) => r.acceptanceCriteria || []);
      if (acList.length > 0) {
        parts.push(`**Key Acceptance Criteria:**`);
        for (const ac of acList.slice(0, 8)) {
          parts.push(`- ${ac}`);
        }
      }
      parts.push(`**Content excerpt:**`);
      parts.push(d.rawContent.slice(0, 1500));
      parts.push(``);
    }
  }

  parts.push(`### SDET Requirement Verification Mandate`);
  parts.push(`When reviewing the diff against these documented requirements, enforce the following:`);
  parts.push(
    `1. **Requirement Failure / Non-compliance**: If the code violates any documented requirement, schema rule, or fails any acceptance criterion, raise a finding with title starting with \`Requirement mismatch:\`. Score as **BLOCKER** or **P1** and mark as merge-blocking.`
  );
  parts.push(
    `2. **Requirement Change to Code Mismatch**: If requirements in docs/jira were modified (see Requirement Change Analysis above) but the code does not implement the new requirement or retains obsolete behavior, raise a finding titled \`Requirement change mismatch:\`. Score as **BLOCKER** or **P1** and mark as merge-blocking.`
  );
  parts.push(
    `3. **Unnecessary Changes / Scope Creep**: If the diff introduces changes, refactoring, new functions, or configuration alterations that are **NOT required or justified** by the attached docs/jira or stated intent, raise a finding titled \`Unnecessary change:\`. In the **Fix** field, provide a concrete suggestion to remove, revert, or separate the change into another PR. Score as **P2** or **P3** (or **P1** if the unnecessary change introduces severe instability or regression risk).`
  );

  return parts.join("\n");
}

function buildValidatorContextSection(
  documents: RequirementDocument[],
  jiraTickets: JiraTicketDetail[],
  changeAnalysis: any
): string {
  const parts: string[] = [
    `## Ground Truth Requirements Context (from attached docs/jira)`,
    ``,
  ];

  if (changeAnalysis.summary) {
    parts.push(changeAnalysis.summary);
    parts.push(``);
  }

  if (jiraTickets.length > 0) {
    parts.push(`### Jira Tickets:`);
    for (const t of jiraTickets.slice(0, 5)) {
      parts.push(`- **[${t.key}]** ${t.summary}`);
      if (t.acceptanceCriteria.length > 0) {
        parts.push(`  Acceptance criteria: ${t.acceptanceCriteria.join(" | ")}`);
      }
    }
    parts.push(``);
  }

  if (documents.length > 0) {
    parts.push(`### Available Requirement Docs:`);
    for (const d of documents.slice(0, 5)) {
      parts.push(`- **${d.title}** (\`${d.filePath}\`): ${d.summary}`);
    }
    parts.push(``);
  }

  parts.push(
    `When validating findings titled with "Requirement mismatch:", "Requirement change mismatch:", or "Unnecessary change:", cross-reference against the ground truth requirements above. ` +
    `CONFIRM requirement mismatches where the code genuinely violates acceptance criteria or fails to implement newly changed requirements. ` +
    `CONFIRM unnecessary changes where the diff modifies code outside the stated requirements.`
  );

  return parts.join("\n");
}
