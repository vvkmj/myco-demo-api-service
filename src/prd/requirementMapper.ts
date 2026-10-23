import { NormalizedRequirement, RequirementValidationResult, ValidationStatus } from "../connectors/types";
import { ChangedFile } from "../github/prFetcher";

// ─────────────────────────────────────────────────────────────────────────────
// Requirement-to-code mapper
//
// Maps each normalized requirement to affected code files, tests, and APIs
// in the PR diff. This mapping is used by the PRD validator to determine
// which requirements are relevant to the current PR.
// ─────────────────────────────────────────────────────────────────────────────

export interface RequirementMapping {
  requirement: NormalizedRequirement;
  /** Code files in the diff that appear related to this requirement */
  affectedCodeFiles: string[];
  /** Test files in the diff that may cover this requirement */
  relatedTestFiles: string[];
  /** How strongly this requirement relates to the PR (0–1) */
  relevanceScore: number;
  /** Keywords that linked the requirement to the code */
  matchedKeywords: string[];
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".java", ".py", ".go", ".rs", ".rb",
  ".cs", ".cpp", ".c", ".php", ".kt", ".swift", ".scala",
]);

const TEST_PATTERNS = [
  /\btests?\b/i,
  /\b__tests__\b/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /Test\.[a-z0-9]+$/i,
];

function isCodeFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  return CODE_EXTENSIONS.has(ext) && !TEST_PATTERNS.some(p => p.test(filename));
}

function isTestFile(filename: string): boolean {
  return TEST_PATTERNS.some(p => p.test(filename));
}

/** Extract meaningful keywords from a requirement for matching */
function extractKeywords(req: NormalizedRequirement): string[] {
  const text = `${req.title} ${req.description} ${req.acceptanceCriteria.join(" ")}`.toLowerCase();

  // Extract multi-word phrases and significant terms
  const words = text
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3)
    // Remove common stop words
    .filter(w => !STOP_WORDS.has(w));

  return [...new Set(words)];
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "will", "should", "must", "shall",
  "when", "then", "given", "been", "being", "each", "every", "more", "also",
  "into", "only", "other", "some", "such", "than", "them", "these", "they",
  "very", "just", "about", "above", "after", "below", "between", "both",
  "does", "done", "during", "here", "once", "same", "there", "through",
  "under", "until", "where", "which", "while", "would", "could",
]);

/**
 * Map requirements to code changes in the PR diff.
 * Uses keyword matching between requirement content and code file paths + patch content.
 */
export function mapRequirementsToCode(
  requirements: NormalizedRequirement[],
  changedFiles: ChangedFile[]
): RequirementMapping[] {
  const codeFiles = changedFiles.filter(f => isCodeFile(f.filename));
  const testFiles = changedFiles.filter(f => isTestFile(f.filename));
  const allFileContent = changedFiles
    .map(f => `${f.filename} ${f.patch || ""}`)
    .join("\n")
    .toLowerCase();

  return requirements.map(req => {
    const keywords = extractKeywords(req);
    const matchedKeywords: string[] = [];
    const affectedCodeFiles: string[] = [];
    const relatedTestFiles: string[] = [];

    // Check each keyword against file paths and patch content
    for (const keyword of keywords) {
      if (allFileContent.includes(keyword)) {
        matchedKeywords.push(keyword);
      }
    }

    // Match code files
    for (const file of codeFiles) {
      const fileContent = `${file.filename} ${file.patch || ""}`.toLowerCase();
      const fileMatches = keywords.filter(k => fileContent.includes(k));
      if (fileMatches.length > 0) {
        affectedCodeFiles.push(file.filename);
      }
    }

    // Match test files
    for (const file of testFiles) {
      const fileContent = `${file.filename} ${file.patch || ""}`.toLowerCase();
      const fileMatches = keywords.filter(k => fileContent.includes(k));
      if (fileMatches.length > 0) {
        relatedTestFiles.push(file.filename);
      }
    }

    // Calculate relevance score (0–1)
    const keywordRatio = keywords.length > 0 ? matchedKeywords.length / keywords.length : 0;
    const hasCodeMatch = affectedCodeFiles.length > 0 ? 0.3 : 0;
    const hasTestMatch = relatedTestFiles.length > 0 ? 0.1 : 0;
    const relevanceScore = Math.min(1, keywordRatio * 0.6 + hasCodeMatch + hasTestMatch);

    return {
      requirement: req,
      affectedCodeFiles,
      relatedTestFiles,
      relevanceScore,
      matchedKeywords: [...new Set(matchedKeywords)],
    };
  });
}

/**
 * Filter mappings to only requirements that are relevant to the PR.
 * Returns requirements with relevance score above threshold.
 */
export function filterRelevantRequirements(
  mappings: RequirementMapping[],
  minRelevance: number = 0.1
): RequirementMapping[] {
  return mappings
    .filter(m => m.relevanceScore >= minRelevance)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}
