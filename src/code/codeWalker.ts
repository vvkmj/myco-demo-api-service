import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 2;            // how many import hops to follow (direct deps + their direct deps)
const MAX_TOTAL_CHARS = 220_000; // ~55k tokens — safety ceiling for the prompt
const ALLOWED_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".json"];

const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", ".git",
  "coverage", ".nyc_output",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function shouldIgnore(filePath: string): boolean {
  return filePath.split(path.sep).some((seg) => IGNORE_DIRS.has(seg));
}

/**
 * Resolve a relative import path from a source file to an absolute path.
 * Handles bare paths, extensions, and index files.
 */
function resolveImport(fromFile: string, importPath: string): string | null {
  const base = path.resolve(path.dirname(fromFile), importPath);

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.json`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function extractImports(content: string): string[] {
  const results: string[] = [];
  // static imports:  import ... from './foo'
  // dynamic imports: import('./foo')
  // require:         require('./foo')
  const re =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    results.push(m[1]);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeContext {
  /** Full concatenated source of all walked files, ready for the prompt. */
  content: string;
  /** All absolute file paths that were included. */
  files: string[];
  /** Absolute paths of test files discovered alongside walked source files. */
  testFiles: string[];
  /** Whether the char budget was hit before the walk finished. */
  truncated: boolean;
}

/**
 * Walk from multiple entry points (e.g. all source files changed in a PR),
 * following relative imports up to MAX_DEPTH hops. A shared visited set and
 * char budget ensure each file is included only once and the total context
 * stays within the LLM token limit.
 *
 * @param entryPoints  Absolute paths to the changed source files in the local clone.
 * @param repoRoot     Root of the local clone — used for relative path labels in output.
 */
export function buildCodeContext(
  entryPoints: string[],
  repoRoot: string
): CodeContext {
  const visited = new Set<string>();
  const chunks: string[] = [];
  const includedFiles: string[] = [];
  const testFiles: string[] = [];
  let totalChars = 0;
  let truncated = false;

  function safeRead(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (totalChars + content.length > MAX_TOTAL_CHARS) {
        truncated = true;
        return null;
      }
      totalChars += content.length;
      return content;
    } catch {
      return null;
    }
  }

  function discoverTestSiblings(filePath: string): void {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);

    const candidates = [
      path.join(dir, `${base}.test.ts`),
      path.join(dir, `${base}.spec.ts`),
      path.join(dir, `${base}.test.tsx`),
      path.join(dir, `${base}.spec.tsx`),
      path.join(dir, `${base}.test.js`),
      path.join(dir, `${base}.spec.js`),
      path.join(dir, "__tests__", `${base}.test.ts`),
      path.join(dir, "__tests__", `${base}.spec.ts`),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c) && !testFiles.includes(c)) {
        testFiles.push(c);
      }
    }
  }

  function walk(filePath: string, depth: number): void {
    if (truncated) return;
    if (depth > MAX_DEPTH) return;
    if (!fs.existsSync(filePath)) return;
    if (visited.has(filePath)) return;
    if (shouldIgnore(filePath)) return;

    const ext = path.extname(filePath);
    if (!ALLOWED_EXTENSIONS.includes(ext)) return;

    // Skip test files from the walked graph — include them separately
    const basename = path.basename(filePath);
    if (
      basename.includes(".test.") ||
      basename.includes(".spec.") ||
      basename.includes("-test.") ||
      basename.includes("-spec.")
    ) {
      return;
    }

    const content = safeRead(filePath);
    if (!content) return;

    visited.add(filePath);
    includedFiles.push(filePath);

    const label = path.relative(repoRoot, filePath);
    chunks.push(`\n\n=== FILE: ${label} ===\n${content}`);

    discoverTestSiblings(filePath);

    for (const importPath of extractImports(content)) {
      const resolved = resolveImport(filePath, importPath);
      if (resolved) walk(resolved, depth + 1);
    }
  }

  for (const ep of entryPoints) {
    walk(path.resolve(ep), 0);
  }

  return {
    content: chunks.join("\n"),
    files: includedFiles,
    testFiles,
    truncated,
  };
}

/**
 * Derive absolute local paths for the non-test source files changed in the PR.
 * Filters out removed files, non-source extensions, and test files.
 */
export function deriveEntryPoints(
  changedFilenames: string[],
  repoRoot: string
): string[] {
  const SOURCE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx"]);
  const TEST_MARKERS = [".test.", ".spec.", "-test.", "-spec.", "_test.", "_spec."];

  return changedFilenames
    .filter((f) => {
      const ext = path.extname(f);
      if (!SOURCE_EXTS.has(ext)) return false;
      if (TEST_MARKERS.some((m) => f.includes(m))) return false;
      return true;
    })
    .map((f) => path.join(repoRoot, f))
    .filter((f) => fs.existsSync(f));
}
