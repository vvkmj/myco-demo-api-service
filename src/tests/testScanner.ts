import * as fs from "fs";
import * as path from "path";

export type TestType = "unit" | "integration" | "component" | "contract";

export interface TestFile {
  path: string;
  type: TestType;
  testCases: string[];
}

export interface TestCoverage {
  byType: Record<TestType, TestFile[]>;
  summary: string;
}

const TEST_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx"];
const TEST_FILE_PATTERNS = [".test.", ".spec.", "-test.", "-spec.", "_test.", "_spec."];
const CONTRACT_EXTENSIONS = [".json", ".yaml", ".yml", ".md"];

const TEST_LABEL_PATTERNS = [
  /(?:describe|it|test|context|specify)\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
];

const MAX_FILE_SIZE = 200_000;
const MAX_FILES_PER_TYPE = 300;
const MAX_CASES_PER_FILE = 60;

function extractTestLabels(content: string): string[] {
  const labels = new Set<string>();
  for (const pattern of TEST_LABEL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      labels.add(match[1].trim());
      if (labels.size >= MAX_CASES_PER_FILE) break;
    }
  }
  return Array.from(labels);
}

function isTestFile(filename: string, isContract: boolean): boolean {
  if (isContract) {
    return CONTRACT_EXTENSIONS.some((ext) => filename.endsWith(ext));
  }
  const ext = path.extname(filename);
  if (!TEST_EXTENSIONS.includes(ext)) return false;
  return TEST_FILE_PATTERNS.some((p) => filename.includes(p));
}

function walkDir(
  dir: string,
  type: TestType,
  collected: TestFile[],
  isContract = false
): void {
  if (!fs.existsSync(dir)) return;
  if (collected.length >= MAX_FILES_PER_TYPE) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (collected.length >= MAX_FILES_PER_TYPE) break;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (["node_modules", "dist", "build", ".git", "coverage"].includes(entry.name))
        continue;
      walkDir(fullPath, type, collected, isContract);
      continue;
    }

    if (!isTestFile(entry.name, isContract)) continue;

    let content = "";
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const testCases = isContract ? [] : extractTestLabels(content);
    collected.push({ path: fullPath, type, testCases });
  }
}

/**
 * Auto-classify a directory name into a test type based on naming conventions
 * commonly used in fleet-streams (and similar TypeScript monorepos).
 *
 * Directory name heuristics:
 *   integration / it / e2e / functional  → integration
 *   component / components               → component
 *   contract / pact / schema             → contract
 *   unit / __tests__ / tests / test      → unit (default)
 */
function classifyDir(dirName: string): TestType {
  const d = dirName.toLowerCase();
  if (/integration|[-_]it$|^it[-_]|e2e|functional/.test(d)) return "integration";
  if (/component/.test(d)) return "component";
  if (/contract|pact|schema/.test(d)) return "contract";
  return "unit";
}

/**
 * Auto-discover all test files inside the sparse-checked-out folders of the
 * cloned repo. Walks each folder that was changed in the PR and classifies
 * test files by directory naming conventions.
 *
 * This means you don't need to manually set UT_PATH / IT_PATH etc. when
 * the repo is available locally.
 *
 * @param repoRoot       Root of the local fleet-streams clone.
 * @param changedFolders Repo-relative folder paths touched by the PR.
 */
export function autoDiscoverTests(
  repoRoot: string,
  changedFolders: string[]
): { unit: string[]; integration: string[]; component: string[]; contract: string[] } {
  const result = { unit: [] as string[], integration: [] as string[], component: [] as string[], contract: [] as string[] };

  if (!fs.existsSync(repoRoot)) return result;

  const seen = new Set<string>();

  function walkForTests(dir: string): void {
    if (!fs.existsSync(dir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".git", "coverage"].includes(entry.name)) continue;
        walkForTests(fullPath);
        continue;
      }

      if (seen.has(fullPath)) continue;

      const ext = path.extname(entry.name);
      const isContractExt = CONTRACT_EXTENSIONS.includes(ext);
      const isSourceExt = TEST_EXTENSIONS.includes(ext);
      const isTestFile =
        (isSourceExt && TEST_FILE_PATTERNS.some((p) => entry.name.includes(p))) ||
        isContractExt;

      if (!isTestFile) continue;

      // Classify based on ancestor directory names
      const segments = fullPath.replace(repoRoot, "").split(path.sep);
      let type: TestType = "unit";
      for (const seg of segments) {
        const candidate = classifyDir(seg);
        if (candidate !== "unit") { type = candidate; break; }
      }
      // Contract extensions always go to contract bucket
      if (isContractExt) type = "contract";

      seen.add(fullPath);
      result[type].push(fullPath);
    }
  }

  // Walk each changed folder (already sparse-checked-out)
  for (const folder of changedFolders) {
    const absFolder = path.join(repoRoot, folder);
    walkForTests(absFolder);
  }

  // Also walk one level up from each changed folder to catch sibling test dirs
  const parentDirs = new Set(changedFolders.map((f) => path.dirname(f)).filter((d) => d !== "."));
  for (const parent of parentDirs) {
    walkForTests(path.join(repoRoot, parent));
  }

  return result;
}

/**
 * Discover co-located unit test files (.test.ts / .spec.ts) next to source files
 * changed in the PR.
 */
export function discoverColocatedUTs(changedFilePaths: string[]): string[] {
  const discovered: string[] = [];
  const testSuffixes = [".test.ts", ".spec.ts", ".test.js", ".spec.js", ".test.tsx", ".spec.tsx"];

  for (const filePath of changedFilePaths) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));

    for (const suffix of testSuffixes) {
      const candidate = path.join(dir, base + suffix);
      if (fs.existsSync(candidate)) {
        discovered.push(candidate);
      }
    }
  }
  return [...new Set(discovered)];
}

/**
 * Scan all provided test root paths and return structured coverage info.
 *
 * @param paths             - map of test type → explicit root paths (from .env)
 * @param changedFiles      - local paths of source files changed in the PR (for co-located UT discovery)
 * @param autoDiscovered    - additional paths found by autoDiscoverTests()
 */
export function scanTestCoverage(
  paths: {
    unit?: string[];
    integration?: string[];
    component?: string[];
    contract?: string[];
  },
  changedFiles: string[] = [],
  autoDiscovered?: { unit: string[]; integration: string[]; component: string[]; contract: string[] }
): TestCoverage {
  const byType: Record<TestType, TestFile[]> = {
    unit: [],
    integration: [],
    component: [],
    contract: [],
  };

  // Auto-discover co-located UTs alongside changed source files
  if (changedFiles.length > 0) {
    const colocated = discoverColocatedUTs(changedFiles);
    for (const testFilePath of colocated) {
      try {
        const stat = fs.statSync(testFilePath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = fs.readFileSync(testFilePath, "utf-8");
        byType.unit.push({
          path: testFilePath,
          type: "unit",
          testCases: extractTestLabels(content),
        });
      } catch {
        // skip unreadable
      }
    }
    if (byType.unit.length > 0) {
      console.log(`  🔎 Auto-discovered ${byType.unit.length} co-located UT file(s)`);
    }
  }

  // Merge auto-discovered paths with explicit env paths (deduplicate)
  const unitPaths = [...new Set([...(paths.unit ?? []), ...(autoDiscovered?.unit ?? [])])];
  const itPaths   = [...new Set([...(paths.integration ?? []), ...(autoDiscovered?.integration ?? [])])];
  const ctPaths   = [...new Set([...(paths.component ?? []), ...(autoDiscovered?.component ?? [])])];
  const cnPaths   = [...new Set([...(paths.contract ?? []), ...(autoDiscovered?.contract ?? [])])];

  for (const p of unitPaths) walkDir(p, "unit", byType.unit);
  for (const p of itPaths)   walkDir(p, "integration", byType.integration);
  for (const p of ctPaths)   walkDir(p, "component", byType.component);
  for (const p of cnPaths)   walkDir(p, "contract", byType.contract, true);

  const summary = buildCoverageSummary(byType);
  return { byType, summary };
}

function buildCoverageSummary(byType: Record<TestType, TestFile[]>): string {
  const sections: string[] = ["## Existing Test Coverage\n"];

  const typeLabels: Record<TestType, string> = {
    unit: "Unit Tests (UTs)",
    integration: "Integration Tests (ITs)",
    component: "Component Tests",
    contract: "Contract Tests",
  };

  for (const [type, files] of Object.entries(byType) as [TestType, TestFile[]][]) {
    const label = typeLabels[type];

    if (files.length === 0) {
      sections.push(
        `### ${label}\n_No ${type} tests found or path not provided._\n`
      );
      continue;
    }

    sections.push(`### ${label} (${files.length} files)\n`);

    for (const file of files) {
      sections.push(`#### \`${file.path}\``);
      if (file.testCases.length > 0) {
        sections.push(
          file.testCases
            .slice(0, MAX_CASES_PER_FILE)
            .map((c) => `- ${c}`)
            .join("\n")
        );
      } else {
        sections.push("_No parseable test labels found._");
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}
