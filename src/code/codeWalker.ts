import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 2;            // how many import hops to follow (direct deps + their direct deps)
const MAX_TOTAL_CHARS = 220_000; // ~55k tokens — safety ceiling for the prompt
const ALLOWED_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".json", ".java"];
const MAX_JAVA_FILES_TO_SCAN = 5_000;

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
function resolveImport(
  fromFile: string,
  importPath: string,
  externalRepos?: Map<string, string>
): string | null {
  if (path.extname(fromFile) === ".java") {
    const sourceRoot = findJavaSourceRoot(fromFile);
    if (!sourceRoot || importPath.endsWith(".*")) return null;
    const candidate = path.join(sourceRoot, ...importPath.split(".")) + ".java";
    return fs.existsSync(candidate) ? candidate : null;
  }

  // Handle external repository mappings if not a relative path
  if (!importPath.startsWith(".") && externalRepos && externalRepos.size > 0) {
    for (const [prefix, extPath] of externalRepos.entries()) {
      if (importPath === prefix || importPath.startsWith(prefix + "/")) {
        const sub = importPath === prefix ? "" : importPath.slice(prefix.length + 1);
        let base = sub ? path.resolve(extPath, sub) : extPath;

        if (!sub && fs.existsSync(path.join(extPath, "package.json"))) {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(extPath, "package.json"), "utf-8"));
            const entry = pkg.types || pkg.typings || pkg.main || pkg.module;
            if (entry) base = path.resolve(extPath, entry);
          } catch {}
        }

        const candidates = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.d.ts`,
          `${base}.js`,
          `${base}.jsx`,
          path.join(base, "index.ts"),
          path.join(base, "index.tsx"),
          path.join(base, "index.d.ts"),
          path.join(base, "index.js"),
          path.join(base, "src", "index.ts"),
          path.join(base, "src", "index.tsx"),
        ];

        for (const c of candidates) {
          try {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
          } catch {}
        }
      }
    }
  }

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

function extractImports(
  content: string,
  extension: string,
  externalRepos?: Map<string, string>
): string[] {
  const results: string[] = [];
  if (extension === ".java") {
    const javaImport = /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(\.\*)?\s*;/gm;
    let match: RegExpExecArray | null;
    while ((match = javaImport.exec(content)) !== null) results.push(match[1] + (match[2] || ""));
    return results;
  }

  // static imports:  import ... from './foo'
  // dynamic imports: import('./foo')
  // require:         require('./foo')
  const re =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".")) {
      results.push(spec);
    } else if (externalRepos && externalRepos.size > 0) {
      for (const prefix of externalRepos.keys()) {
        if (spec === prefix || spec.startsWith(prefix + "/")) {
          results.push(spec);
          break;
        }
      }
    }
  }
  return results;
}

function findJavaSourceRoot(filePath: string): string | null {
  const parts = path.resolve(filePath).split(path.sep);
  for (let i = 0; i <= parts.length - 4; i++) {
    if (parts[i] === "src" && (parts[i + 1] === "main" || parts[i + 1] === "test") && parts[i + 2] === "java") {
      return parts.slice(0, i + 3).join(path.sep);
    }
  }
  return null;
}

function javaQualifiedName(filePath: string, content: string): string | null {
  const packageMatch = /^\s*package\s+([\w.]+)\s*;/m.exec(content);
  if (!packageMatch) return null;
  return `${packageMatch[1]}.${path.basename(filePath, ".java")}`;
}

function findJavaDependents(filePath: string, content: string): string[] {
  const sourceRoot = findJavaSourceRoot(filePath);
  const qualifiedName = javaQualifiedName(filePath, content);
  if (!sourceRoot || !qualifiedName) return [];

  const dependents: string[] = [];
  const simpleName = path.basename(filePath, ".java");
  const packageName = qualifiedName.slice(0, -(simpleName.length + 1));
  const stack = [sourceRoot];

  while (stack.length > 0 && dependents.length < MAX_JAVA_FILES_TO_SCAN) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldIgnore(candidate)) stack.push(candidate);
        continue;
      }
      if (!entry.isFile() || !candidate.endsWith(".java") || candidate === filePath) continue;

      try {
        const candidateContent = fs.readFileSync(candidate, "utf-8");
        const imports = extractImports(candidateContent, ".java");
        const importsTarget = imports.includes(qualifiedName);
        const importsPackage = imports.includes(`${packageName}.*`) &&
          new RegExp(`\\b${escapeRegExp(simpleName)}\\b`).test(candidateContent);
        if (importsTarget || importsPackage) dependents.push(candidate);
      } catch {
        // A file becoming unreadable must not stop review of the PR.
      }
    }
  }

  return dependents;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  repoRoot: string,
  externalRepos?: Map<string, string>
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
      path.join(dir, `${base}Test.java`),
      path.join(dir, `${base}Tests.java`),
    ];

    const javaSourceRoot = ext === ".java" ? findJavaSourceRoot(filePath) : null;
    if (javaSourceRoot?.includes(`${path.sep}src${path.sep}main${path.sep}java`)) {
      const relative = path.relative(javaSourceRoot, filePath);
      const testRoot = javaSourceRoot.replace(
        `${path.sep}src${path.sep}main${path.sep}java`,
        `${path.sep}src${path.sep}test${path.sep}java`
      );
      const testBase = path.basename(relative, ".java");
      candidates.push(
        path.join(testRoot, path.dirname(relative), `${testBase}Test.java`),
        path.join(testRoot, path.dirname(relative), `${testBase}IT.java`)
      );
    }

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

    let label = path.relative(repoRoot, filePath);
    if (label.startsWith("..") && externalRepos) {
      for (const [slugOrPrefix, extPath] of externalRepos.entries()) {
        const relExt = path.relative(extPath, filePath);
        if (!relExt.startsWith("..")) {
          label = `[${slugOrPrefix}] ${relExt}`;
          break;
        }
      }
    }
    chunks.push(`\n\n=== FILE: ${label} ===\n${content}`);

    discoverTestSiblings(filePath);

    for (const importPath of extractImports(content, ext, externalRepos)) {
      const resolved = resolveImport(filePath, importPath, externalRepos);
      if (resolved) walk(resolved, depth + 1);
    }

    if (ext === ".java") {
      for (const dependent of findJavaDependents(filePath, content)) {
        walk(dependent, depth + 1);
      }
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
  const SOURCE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".java"]);
  const TEST_MARKERS = [".test.", ".spec.", "-test.", "-spec.", "_test.", "_spec."];

  return changedFilenames
    .filter((f) => {
      const ext = path.extname(f);
      if (!SOURCE_EXTS.has(ext)) return false;
      if (TEST_MARKERS.some((m) => f.includes(m))) return false;
      if (ext === ".java" && /(Test|Tests|IT)\.java$/i.test(f)) return false;
      return true;
    })
    .map((f) => path.join(repoRoot, f))
    .filter((f) => fs.existsSync(f));
}
