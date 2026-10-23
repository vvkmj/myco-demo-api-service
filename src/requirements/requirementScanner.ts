import * as fs from "fs";
import * as path from "path";
import {
  RequirementDocument,
  RequirementItem,
  JiraTicketDetail,
} from "./requirementTypes";
import { ChangedFile } from "../github/prFetcher";

const MAX_TOTAL_REQUIREMENTS_CHARS = 45000;
const MAX_DOC_CHARS = 12000;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target-repo",
  ".gemini",
  "coverage",
  "reviews",
  ".next",
  ".turbo",
]);

const REQUIREMENT_DIR_CANDIDATES = [
  "docs",
  "doc",
  "specs",
  "spec",
  "requirements",
  "requirement",
  "rfcs",
  "rfc",
  "architecture",
  "jira",
  ".jira",
  "tickets",
  ".tickets",
  "issues",
  ".issues",
  ".github/requirements",
  ".github/docs",
];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".json", ".yaml", ".yml"]);

/**
 * Extract ticket keys like "PROJ-123", "MYCO-42", "ABC-1" from text.
 */
export function extractJiraKeys(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/g);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Scan a single file and parse it into a RequirementDocument if applicable.
 */
export function parseRequirementFile(
  fullPath: string,
  relPath: string
): RequirementDocument | null {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null; // skip > 2MB

    const ext = path.extname(fullPath).toLowerCase();
    if (!DOC_EXTENSIONS.has(ext)) return null;

    const baseName = path.basename(fullPath);
    const raw = fs.readFileSync(fullPath, "utf-8");

    // Case 1: JSON file (Jira export or schema)
    if (ext === ".json") {
      return parseJsonRequirement(fullPath, relPath, raw);
    }

    // Case 2: Markdown or text requirement/spec/Jira file
    return parseMarkdownRequirement(fullPath, relPath, raw);
  } catch (err) {
    return null;
  }
}

/**
 * Parse JSON file looking for Jira issue structure or generic requirement schema.
 */
function parseJsonRequirement(
  fullPath: string,
  relPath: string,
  raw: string
): RequirementDocument | null {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;

    // Check for Jira-style object (direct key or Jira issue export)
    const isJira =
      (data.key && typeof data.key === "string" && /^[A-Z][A-Z0-9]+-\d+$/.test(data.key)) ||
      (data.fields && typeof data.fields.summary === "string");

    if (isJira) {
      const key = data.key || data.fields?.key || path.basename(fullPath, ".json");
      const summary = data.fields?.summary || data.summary || "Jira Issue";
      const description =
        typeof data.fields?.description === "string"
          ? data.fields.description
          : typeof data.description === "string"
          ? data.description
          : JSON.stringify(data.fields?.description || data.description || "");

      const acceptanceCriteria: string[] = [];
      if (Array.isArray(data.acceptanceCriteria)) {
        acceptanceCriteria.push(...data.acceptanceCriteria.map(String));
      } else if (typeof data.acceptanceCriteria === "string") {
        acceptanceCriteria.push(data.acceptanceCriteria);
      } else if (data.fields?.customfield_acceptance_criteria) {
        acceptanceCriteria.push(String(data.fields.customfield_acceptance_criteria));
      } else {
        // Extract AC from description
        acceptanceCriteria.push(...extractAcFromText(description));
      }

      const ticket: JiraTicketDetail = {
        key,
        summary,
        description: description.slice(0, 3000),
        issueType: data.fields?.issuetype?.name || data.issueType || "Task",
        status: data.fields?.status?.name || data.status,
        priority: data.fields?.priority?.name || data.priority,
        acceptanceCriteria,
        filePath: relPath,
      };

      const reqItem: RequirementItem = {
        id: key,
        title: summary,
        sourceFile: relPath,
        sourceType: "jira",
        category: "functional",
        content: `Summary: ${summary}\nType: ${ticket.issueType}\nStatus: ${ticket.status || "Open"}\nDescription:\n${ticket.description}`,
        acceptanceCriteria,
      };

      return {
        filePath: relPath,
        fileName: path.basename(fullPath),
        docType: "jira_export",
        title: `${key}: ${summary}`,
        rawContent: raw.slice(0, MAX_DOC_CHARS),
        summary: `Jira ticket ${key} (${ticket.issueType}) - ${summary}`,
        requirements: [reqItem],
        jiraTickets: [ticket],
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract acceptance criteria items from markdown or text.
 */
function extractAcFromText(text: string): string[] {
  const acList: string[] = [];
  const lines = text.split("\n");
  let inAcSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Section header check
    if (/^#+\s*(acceptance\s*criteria|ac|verification\s*criteria)\b/i.test(line)) {
      inAcSection = true;
      continue;
    } else if (inAcSection && /^#+\s+[A-Za-z0-9]/.test(line)) {
      inAcSection = false;
    }

    // Checkbox items: "- [ ] AC 1" or "- [x] AC 2"
    const checkboxMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (checkboxMatch) {
      acList.push(checkboxMatch[2].trim());
      continue;
    }

    // Numbered or bullet list in AC section
    if (inAcSection && /^[-*•\d+.]\s+(.+)$/.test(line)) {
      const item = line.replace(/^[-*•\d+.]\s+/, "").trim();
      if (item.length > 5) acList.push(item);
    }
  }

  return acList;
}

/**
 * Parse Markdown requirement / specification / Jira file.
 */
function parseMarkdownRequirement(
  fullPath: string,
  relPath: string,
  raw: string
): RequirementDocument | null {
  const baseName = path.basename(fullPath);
  const isJiraFolder = /(?:^|\/)(?:jira|\.jira|tickets|\.tickets|issues|\.issues)(?:\/|$)/i.test(relPath);
  const hasJiraKeyInName = /^[A-Z][A-Z0-9]+-\d+/i.test(baseName);
  const isDocFolder = /(?:^|\/)(?:docs|specs|requirements|rfcs|architecture)(?:\/|$)/i.test(relPath);
  const isDocNamed = /(?:spec|requirement|prd|design|user_story|rfc)/i.test(baseName);

  if (!isJiraFolder && !hasJiraKeyInName && !isDocFolder && !isDocNamed) {
    // Only parse if it contains explicit requirement keywords
    if (!/(?:acceptance\s*criteria|functional\s*requirements?|user\s*stor(?:y|ies)|jira\s*issue)/i.test(raw)) {
      return null;
    }
  }

  const lines = raw.split("\n");
  let title = baseName;
  for (const l of lines) {
    const hMatch = l.match(/^#\s+(.+)$/);
    if (hMatch) {
      title = hMatch[1].trim();
      break;
    }
  }

  const acList = extractAcFromText(raw);
  const requirements: RequirementItem[] = [];
  const jiraTickets: JiraTicketDetail[] = [];

  // Check if it's a Jira ticket representation
  const jiraKeyMatch = baseName.match(/^([A-Z][A-Z0-9]+-\d+)/i) || raw.match(/(?:ticket|issue|jira):\s*([A-Z][A-Z0-9]+-\d+)/i);
  if (isJiraFolder || jiraKeyMatch) {
    const key = jiraKeyMatch ? jiraKeyMatch[1].toUpperCase() : path.basename(fullPath, path.extname(fullPath));
    const ticket: JiraTicketDetail = {
      key,
      summary: title,
      description: raw.slice(0, 3000),
      issueType: /type:\s*(\w+)/i.exec(raw)?.[1] || "Story",
      status: /status:\s*(\w+)/i.exec(raw)?.[1],
      priority: /priority:\s*(\w+)/i.exec(raw)?.[1],
      acceptanceCriteria: acList,
      filePath: relPath,
    };
    jiraTickets.push(ticket);

    requirements.push({
      id: key,
      title: `${key}: ${title}`,
      sourceFile: relPath,
      sourceType: "jira",
      category: "functional",
      content: raw.slice(0, 4000),
      acceptanceCriteria: acList,
    });
  } else {
    // Standard spec/requirement document
    // Extract major sections
    let currentSection = "";
    let currentContent: string[] = [];
    let sectionCount = 0;

    for (const line of lines) {
      const secMatch = line.match(/^##\s+(.+)$/);
      if (secMatch) {
        if (currentSection && currentContent.length > 0) {
          sectionCount++;
          requirements.push({
            id: `REQ-${sectionCount}`,
            title: `${title} - ${currentSection}`,
            sourceFile: relPath,
            sourceType: "doc",
            category: /acceptance|criteria/i.test(currentSection)
              ? "acceptance_criteria"
              : /constraint|limit/i.test(currentSection)
              ? "constraint"
              : "functional",
            content: currentContent.join("\n").trim().slice(0, 2500),
            acceptanceCriteria: /acceptance|criteria/i.test(currentSection) ? acList : undefined,
          });
        }
        currentSection = secMatch[1].trim();
        currentContent = [];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    if (currentSection && currentContent.length > 0) {
      sectionCount++;
      requirements.push({
        id: `REQ-${sectionCount}`,
        title: `${title} - ${currentSection}`,
        sourceFile: relPath,
        sourceType: "doc",
        content: currentContent.join("\n").trim().slice(0, 2500),
        acceptanceCriteria: /acceptance|criteria/i.test(currentSection) ? acList : undefined,
      });
    }

    // If no ## sections were found, create a single overarching requirement item
    if (requirements.length === 0) {
      requirements.push({
        id: `DOC-1`,
        title,
        sourceFile: relPath,
        sourceType: "doc",
        content: raw.slice(0, 4000),
        acceptanceCriteria: acList.length > 0 ? acList : undefined,
      });
    }
  }

  return {
    filePath: relPath,
    fileName: baseName,
    docType: isJiraFolder || jiraTickets.length > 0 ? "jira_ticket" : "markdown_doc",
    title,
    rawContent: raw.slice(0, MAX_DOC_CHARS),
    summary: `${title} (${acList.length} acceptance criteria, ${requirements.length} sections)`,
    requirements,
    jiraTickets: jiraTickets.length > 0 ? jiraTickets : undefined,
  };
}

/**
 * Scan a repository or local folder for all requirement documents and Jira tickets.
 */
export function scanFolderRequirements(
  repoPath: string,
  changedFiles: ChangedFile[] = [],
  prContextText: string = ""
): {
  documents: RequirementDocument[];
  allRequirements: RequirementItem[];
  jiraTickets: JiraTicketDetail[];
} {
  const documents: RequirementDocument[] = [];
  const allRequirements: RequirementItem[] = [];
  const allJiraTickets: JiraTicketDetail[] = [];

  if (!fs.existsSync(repoPath)) {
    return { documents, allRequirements, jiraTickets: allJiraTickets };
  }

  const linkedKeys = extractJiraKeys(prContextText);
  const foundFilePaths = new Set<string>();

  // 1. Check custom path env vars if present
  const customPaths = [
    process.env.REQUIREMENTS_PATH,
    process.env.JIRA_DOCS_PATH,
    process.env.DOCS_PATH,
  ].filter(Boolean) as string[];

  const searchRoots: string[] = [];

  for (const cp of customPaths) {
    const resolved = path.isAbsolute(cp) ? cp : path.join(repoPath, cp);
    if (fs.existsSync(resolved)) searchRoots.push(resolved);
  }

  // 2. Discover standard candidate directories
  for (const candidate of REQUIREMENT_DIR_CANDIDATES) {
    const candidatePath = path.join(repoPath, candidate);
    if (fs.existsSync(candidatePath)) {
      searchRoots.push(candidatePath);
    }
  }

  // Also check top-level files in repoPath
  try {
    const rootFiles = fs.readdirSync(repoPath);
    for (const f of rootFiles) {
      const full = path.join(repoPath, f);
      const stat = fs.statSync(full);
      if (stat.isFile() && DOC_EXTENSIONS.has(path.extname(f).toLowerCase())) {
        if (
          /(?:spec|requirement|prd|design|jira|ticket|issue|rfc)/i.test(f) ||
          linkedKeys.some((k) => f.toUpperCase().includes(k))
        ) {
          foundFilePaths.add(full);
        }
      }
    }
  } catch {}

  // Recursive walk of search roots
  function walkDir(dir: string, depth: number) {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (DOC_EXTENSIONS.has(ext)) {
            foundFilePaths.add(full);
          }
        }
      }
    } catch {}
  }

  for (const root of searchRoots) {
    const stat = fs.statSync(root);
    if (stat.isDirectory()) {
      walkDir(root, 1);
    } else if (stat.isFile()) {
      foundFilePaths.add(root);
    }
  }

  // Parse each discovered file
  for (const fullPath of foundFilePaths) {
    const relPath = path.relative(repoPath, fullPath).replace(/\\/g, "/");
    const doc = parseRequirementFile(fullPath, relPath);
    if (doc) {
      documents.push(doc);
      allRequirements.push(...doc.requirements);
      if (doc.jiraTickets) {
        allJiraTickets.push(...doc.jiraTickets);
      }
    }
  }

  // Prioritize documents:
  // 1. Documents matching linked Jira keys in PR title/desc
  // 2. Documents that were directly touched in changedFiles
  // 3. Other requirement documents
  const changedFileNames = new Set(changedFiles.map((c) => c.filename));

  documents.sort((a, b) => {
    const aLinked = linkedKeys.some((k) => a.filePath.toUpperCase().includes(k) || a.title.toUpperCase().includes(k));
    const bLinked = linkedKeys.some((k) => b.filePath.toUpperCase().includes(k) || b.title.toUpperCase().includes(k));
    if (aLinked && !bLinked) return -1;
    if (!aLinked && bLinked) return 1;

    const aChanged = changedFileNames.has(a.filePath);
    const bChanged = changedFileNames.has(b.filePath);
    if (aChanged && !bChanged) return -1;
    if (!aChanged && bChanged) return 1;

    return 0;
  });

  return {
    documents,
    allRequirements,
    jiraTickets: allJiraTickets,
  };
}
