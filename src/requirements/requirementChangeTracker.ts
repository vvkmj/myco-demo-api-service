import { ChangedFile } from "../github/prFetcher";
import { RequirementDocument, RequirementChangeAnalysis } from "./requirementTypes";

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".java",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".cs",
  ".cpp",
  ".c",
  ".php",
  ".kt",
  ".swift",
  ".scala",
]);

const TEST_PATH_PATTERNS = [
  /\btests?\b/i,
  /\b__tests__\b/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /Test\.[a-z0-9]+$/i,
  /IT\.[a-z0-9]+$/i,
];

export function isRequirementFile(filename: string, scannedDocs: RequirementDocument[]): boolean {
  const norm = filename.replace(/\\/g, "/").toLowerCase();

  // If already in scanned docs
  if (scannedDocs.some((d) => d.filePath.toLowerCase() === norm)) {
    return true;
  }

  // Check path patterns
  if (
    /(?:^|\/)(?:docs|doc|specs|spec|requirements|rfcs|jira|\.jira|tickets|\.tickets|issues|\.issues)(?:\/|$)/i.test(
      norm
    )
  ) {
    return /\.(md|mdx|txt|json|yaml|yml)$/i.test(norm);
  }

  return /(?:spec|requirement|prd|design|jira|user_story)\.(md|mdx|txt|json)$/i.test(norm);
}

export function isCodeFile(filename: string): boolean {
  const norm = filename.replace(/\\/g, "/");
  if (TEST_PATH_PATTERNS.some((p) => p.test(norm))) return false;
  const ext = norm.substring(norm.lastIndexOf(".")).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/**
 * Extracts added and removed requirement lines from a diff patch.
 */
function extractPatchDeltas(patch?: string): { added: string[]; removed: string[] } {
  if (!patch) return { added: [], removed: [] };

  const added: string[] = [];
  const removed: string[] = [];
  const lines = patch.split("\n");

  for (const line of lines) {
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
    // Check if line starts with + or - (allowing for line-number annotations like `+44: ` or `-42: `)
    const addMatch = line.match(/^(?:\+\d+:\s*|\+)(.*)$/);
    if (addMatch) {
      const content = addMatch[1].trim();
      if (content.length > 5 && !content.startsWith("#") && !content.startsWith("```")) {
        added.push(content);
      }
      continue;
    }

    const delMatch = line.match(/^(?:-\d+:\s*|-)(.*)$/);
    if (delMatch) {
      const content = delMatch[1].trim();
      if (content.length > 5 && !content.startsWith("#") && !content.startsWith("```")) {
        removed.push(content);
      }
      continue;
    }
  }

  return { added, removed };
}

/**
 * Analyze changed files to detect requirement changes vs code changes,
 * surfacing potential requirement change mismatches and scope anomalies.
 */
export function analyzeRequirementChanges(
  changedFiles: ChangedFile[],
  scannedDocs: RequirementDocument[]
): RequirementChangeAnalysis {
  const modifiedReqFiles: string[] = [];
  const codeFilesTouched: string[] = [];
  const addedReqs: string[] = [];
  const removedReqs: string[] = [];
  const modifiedReqs: string[] = [];

  for (const f of changedFiles) {
    if (isRequirementFile(f.filename, scannedDocs)) {
      modifiedReqFiles.push(f.filename);
      const deltas = extractPatchDeltas(f.patch);
      if (deltas.added.length > 0) {
        addedReqs.push(...deltas.added.map((a) => `[${f.filename}] ${a}`));
      }
      if (deltas.removed.length > 0) {
        removedReqs.push(...deltas.removed.map((r) => `[${f.filename}] ${r}`));
      }
      if (deltas.added.length > 0 || deltas.removed.length > 0) {
        modifiedReqs.push(
          `${f.filename} (+${deltas.added.length} requirements added, -${deltas.removed.length} removed)`
        );
      }
    } else if (isCodeFile(f.filename)) {
      codeFilesTouched.push(f.filename);
    }
  }

  const hasRequirementChanges = modifiedReqFiles.length > 0;

  // Build a summary of requirement changes
  const summaryParts: string[] = [];

  if (hasRequirementChanges) {
    summaryParts.push(
      `⚠️ **Requirement Changes Detected in Diff (${modifiedReqFiles.length} doc/jira file(s) modified)**:`
    );
    for (const mf of modifiedReqs) {
      summaryParts.push(`- ${mf}`);
    }

    if (codeFilesTouched.length > 0) {
      summaryParts.push(
        `\n**CRITICAL VERIFICATION REQUIRED (Requirement Change to Code Mismatch):**` +
        `\nThe requirements in \`${modifiedReqFiles.join(", ")}\` were changed alongside code files (\`${codeFilesTouched.slice(0, 5).join(", ")}${codeFilesTouched.length > 5 ? "..." : ""}\`).` +
        `\nYou must verify that:` +
        `\n1. The code changes accurately implement the *new/updated* requirements.` +
        `\n2. The code does NOT retain obsolete behavior corresponding to removed requirements.` +
        `\n3. Any gap where code fails to reflect the updated requirement MUST be flagged as **[BLOCKER/P1] Requirement change mismatch**.`
      );
    } else {
      summaryParts.push(
        `\nℹ️ **Documentation/Requirement Only Change**: No source code files were touched in this change.`
      );
    }

    if (addedReqs.length > 0) {
      summaryParts.push(`\n**Added Requirements / Acceptance Criteria:**`);
      for (const a of addedReqs.slice(0, 15)) {
        summaryParts.push(`- \`${a}\``);
      }
      if (addedReqs.length > 15) {
        summaryParts.push(`- _...and ${addedReqs.length - 15} more added requirement clauses_`);
      }
    }

    if (removedReqs.length > 0) {
      summaryParts.push(`\n**Deprecated / Removed Requirements:**`);
      for (const r of removedReqs.slice(0, 10)) {
        summaryParts.push(`- ~~\`${r}\`~~`);
      }
    }
  } else if (scannedDocs.length > 0 && codeFilesTouched.length > 0) {
    summaryParts.push(
      `ℹ️ **Existing Requirements Active (${scannedDocs.length} doc/jira file(s) found in repository)**:` +
      `\nNo requirement documentation files were modified in this diff. Verify that all code changes comply with the documented requirements in the repository, and flag any unrequested or unnecessary changes as **Unnecessary change / Scope creep**.`
    );
  }

  return {
    hasRequirementChanges,
    modifiedRequirementFiles: modifiedReqFiles,
    addedRequirements: addedReqs,
    modifiedRequirements: modifiedReqs,
    removedRequirements: removedReqs,
    codeFilesTouched,
    summary: summaryParts.join("\n"),
  };
}
