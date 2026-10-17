import * as fs from "fs";
import * as path from "path";
import { DiffContext, ChangedFile } from "../github/prFetcher";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A mapping from a local import specifier (npm scope, Go module prefix,
 * Maven groupId, etc.) to the GitHub repo that owns it.
 *
 * Example: { "@shared/types": "MyOrg/shared-types" }
 */
export interface RepoMapping {
  /** The import specifier prefix (e.g. "@shared/types", "github.com/org/repo"). */
  importPrefix: string;
  /** GitHub "owner/repo" slug for the external repository. */
  repoSlug: string;
  /** Optional branch override — defaults to "main". */
  branch?: string;
  /** Optional auth token override for private repos. */
  token?: string;
}

/**
 * A resolved external dependency that the PR code depends on or that
 * depends on the PR code.
 */
export interface ExternalRepoDependency {
  /** GitHub "owner/repo" slug. */
  repoSlug: string;
  /** Full clone URL. */
  repoUrl: string;
  /** Branch to clone. */
  branch: string;
  /** Auth token (if any). */
  token?: string;
  /** The import specifiers from the diff that point to this repo. */
  importSpecifiers: string[];
  /** Specific symbols imported from this repo (best-effort extraction). */
  importedSymbols: string[];
  /** The files in the PR that reference this external repo. */
  referencingFiles: string[];
  /** Whether this was auto-detected or explicitly mapped. */
  detectionMethod: "auto-detect" | "explicit-mapping";
}

/**
 * Result of the multi-repo resolution phase.
 */
export interface MultiRepoResolution {
  /** External repos that need to be cloned and checked. */
  dependencies: ExternalRepoDependency[];
  /** Import specifiers that were detected but could not be mapped to a repo. */
  unmappedImports: string[];
  /** Whether any cross-repo dependencies were detected at all. */
  hasCrossRepoDeps: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the MULTI_REPO_MAP env var into structured mappings.
 *
 * Format: JSON object where keys are import prefixes and values are
 * "owner/repo" slugs or objects with { repo, branch?, token? }.
 *
 * Examples:
 *   {"@shared/types": "MyOrg/shared-types"}
 *   {"@shared/types": {"repo": "MyOrg/shared-types", "branch": "develop"}}
 */
export function parseRepoMappings(raw: string | undefined): RepoMapping[] {
  if (!raw || raw.trim().length === 0) return [];

  let parsed: Record<string, string | { repo: string; branch?: string; token?: string }>;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.warn(`  ⚠️   MULTI_REPO_MAP is not valid JSON — skipping explicit mappings: ${err.message}`);
    return [];
  }

  const mappings: RepoMapping[] = [];
  for (const [prefix, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      mappings.push({ importPrefix: prefix, repoSlug: value });
    } else if (value && typeof value === "object" && value.repo) {
      mappings.push({
        importPrefix: prefix,
        repoSlug: value.repo,
        branch: value.branch,
        token: value.token,
      });
    }
  }
  return mappings;
}

/**
 * Parse the MULTI_REPO_TOKENS env var — a JSON object mapping
 * "owner/repo" slugs to auth tokens for private repos.
 */
export function parseRepoTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  if (!raw || raw.trim().length === 0) return tokens;

  try {
    const parsed = JSON.parse(raw);
    for (const [slug, token] of Object.entries(parsed)) {
      if (typeof token === "string") tokens.set(slug, token);
    }
  } catch (err: any) {
    console.warn(`  ⚠️   MULTI_REPO_TOKENS is not valid JSON — skipping: ${err.message}`);
  }
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import extraction from diff patches
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedImport {
  /** The raw import specifier (e.g. "@shared/types", "github.com/org/repo/pkg"). */
  specifier: string;
  /** Specific named symbols imported (e.g. ["UserType", "ApiResponse"]). */
  symbols: string[];
  /** The file that contains this import. */
  sourceFile: string;
}

/**
 * Extract import specifiers from a file's content (full file, not just patch).
 * Focuses on imports that look like they come from external packages/repos
 * rather than relative imports (which are intra-repo).
 */
function extractExternalImports(content: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const ext = path.extname(filePath);

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    // 1. Static imports and re-exports:
    // import { A, B } from "@scope/pkg"
    // import A, { B } from "@scope/pkg"
    // import * as All from "@scope/pkg"
    // import Def from "@scope/pkg"
    // import type { A } from "@scope/pkg"
    // export { A, B } from "@scope/pkg"
    // export * from "@scope/pkg"
    const staticRe =
      /(?:import|export)\s+(?:type\s+)?(?:(?:[\w$]+\s*,?\s*)?(?:(?:\*\s+as\s+[\w$]+|\{([^}]*)\})\s*)?)from\s*['"]([^'"]+)['"]/g;

    let match: RegExpExecArray | null;
    while ((match = staticRe.exec(content)) !== null) {
      const namedImports = match[1] || "";
      const specifier = match[2];

      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (isNodeBuiltin(specifier)) continue;

      const symbols: string[] = [];
      if (namedImports) {
        symbols.push(
          ...namedImports
            .split(",")
            .map((s) => s.trim().replace(/^type\s+/, "").replace(/\s+as\s+\w+/, "").trim())
            .filter(Boolean)
        );
      }

      results.push({ specifier, symbols, sourceFile: filePath });
    }

    // 2. Default-only import: import Foo from "@scope/pkg"
    const defaultRe = /import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = defaultRe.exec(content)) !== null) {
      const defaultImport = match[1];
      const specifier = match[2];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (isNodeBuiltin(specifier) || defaultImport === "type") continue;

      // Don't duplicate if already added
      const existing = results.find((r) => r.specifier === specifier && r.sourceFile === filePath);
      if (existing) {
        if (!existing.symbols.includes(defaultImport)) existing.symbols.push(defaultImport);
      } else {
        results.push({ specifier, symbols: [defaultImport], sourceFile: filePath });
      }
    }

    // 3. Dynamic imports & require: require("@scope/pkg") or import("@scope/pkg")
    const dynamicRe = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicRe.exec(content)) !== null) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (isNodeBuiltin(specifier)) continue;

      if (!results.some((r) => r.specifier === specifier && r.sourceFile === filePath)) {
        results.push({ specifier, symbols: [], sourceFile: filePath });
      }
    }
  }

  if (ext === ".java") {
    // Java:  import com.org.shared.types.UserType;
    const javaImportRe = /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?:\.\*)?;/gm;
    let match: RegExpExecArray | null;
    while ((match = javaImportRe.exec(content)) !== null) {
      const fullImport = match[1];
      const parts = fullImport.split(".");
      const simpleName = parts[parts.length - 1];
      results.push({ specifier: fullImport, symbols: [simpleName], sourceFile: filePath });
    }
  }

  if (ext === ".go") {
    // Go: single import "github.com/org/repo/pkg"
    const singleGo = /import\s+(?:[\w.]+\s+)?["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = singleGo.exec(content)) !== null) {
      if (match[1].includes(".")) {
        results.push({ specifier: match[1], symbols: [], sourceFile: filePath });
      }
    }

    // Go: grouped imports import (\n "github.com/..." \n)
    const groupedGo = /import\s*\(([\s\S]*?)\)/g;
    while ((match = groupedGo.exec(content)) !== null) {
      const block = match[1];
      const lineRe = /(?:[\w.]+\s+)?["']([^"']+)["']/g;
      let lineMatch: RegExpExecArray | null;
      while ((lineMatch = lineRe.exec(block)) !== null) {
        if (lineMatch[1].includes(".")) {
          results.push({ specifier: lineMatch[1], symbols: [], sourceFile: filePath });
        }
      }
    }
  }

  if (ext === ".py") {
    // Python: from pkg.sub import Foo, Bar
    const pyFromRe = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+([^#\n]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = pyFromRe.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith(".")) continue;
      const symbols = match[2]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      results.push({ specifier, symbols, sourceFile: filePath });
    }

    // Python: import pkg
    const pyImportRe = /^\s*import\s+([A-Za-z0-9_.]+)/gm;
    while ((match = pyImportRe.exec(content)) !== null) {
      const specifier = match[1];
      results.push({ specifier, symbols: [], sourceFile: filePath });
    }
  }

  return results;
}

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "domain", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads",
  "zlib", "node:fs", "node:path", "node:crypto", "node:http", "node:https",
  "node:url", "node:util", "node:stream", "node:os", "node:child_process",
  "node:events", "node:net", "node:buffer", "node:assert", "node:worker_threads",
]);

function isNodeBuiltin(specifier: string): boolean {
  return NODE_BUILTINS.has(specifier) || specifier.startsWith("node:");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detection: infer repo slug from package.json in cloned repo
// ─────────────────────────────────────────────────────────────────────────────

interface PackageDep {
  name: string;
  /** The package.json "repository" field, if present. */
  repoSlug?: string;
}

/**
 * Read the local repo's package.json (if it exists) to find
 * dependencies that might point to GitHub repositories.
 */
function readLocalPackageDeps(repoPath: string): Map<string, string> {
  const depMap = new Map<string, string>();
  const pkgPath = path.join(repoPath, "package.json");
  if (!fs.existsSync(pkgPath)) return depMap;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };

    // Look for git URLs or GitHub shorthand links
    for (const [name, version] of Object.entries(allDeps)) {
      if (typeof version === "string") {
        // GitHub shorthand or URL: "github:org/repo", "org/repo", "git+https://github.com/org/repo.git"
        const ghMatch = version.match(
          /(?:github\.com[/:]|github:|^)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/
        );
        if (ghMatch && ghMatch[1] && ghMatch[2]) {
          depMap.set(name, `${ghMatch[1]}/${ghMatch[2]}`);
        }
      }
    }
  } catch {
    // malformed package.json — skip
  }

  return depMap;
}

/**
 * Try to resolve a package name to a GitHub "owner/repo" slug
 * by checking the npm registry metadata (best-effort, no auth required for public).
 * Skipped in production to avoid network calls — use explicit MULTI_REPO_MAP instead.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a PR diff and local repo to resolve cross-repository dependencies.
 *
 * This is the main entry point for multi-repo resolution. It:
 * 1. Extracts import specifiers from all changed files (full file content, not just patches)
 * 2. Matches imports against explicit mappings (MULTI_REPO_MAP)
 * 3. If auto-detect is enabled, tries to infer repo slugs from package.json
 * 4. Deduplicates and returns the list of external repos to clone
 *
 * @param diff        The PR diff context
 * @param repoPath    Path to the locally cloned PR repo
 * @param mappings    Explicit import-prefix → repo mappings
 * @param tokens      Per-repo auth tokens
 * @param autoDetect  Whether to auto-detect repos from package.json
 */
export function resolveMultiRepoDependencies(
  diff: DiffContext,
  repoPath: string,
  mappings: RepoMapping[],
  tokens: Map<string, string>,
  autoDetect: boolean
): MultiRepoResolution {
  console.log("\n🔗  Resolving cross-repository dependencies...");

  // Collect all external imports from changed files
  const allImports: ExtractedImport[] = [];

  for (const changed of diff.changedFiles) {
    if (changed.status === "removed") continue;
    const filePath = path.join(repoPath, changed.filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = extractExternalImports(content, changed.filename);
      allImports.push(...imports);
    } catch {
      // File unreadable — skip
    }
  }

  if (allImports.length === 0) {
    console.log("  ℹ️   No external imports detected in changed files.");
    return { dependencies: [], unmappedImports: [], hasCrossRepoDeps: false };
  }

  console.log(`  📦  Found ${allImports.length} external import(s) across changed files.`);

  // Build auto-detected mapping from package.json
  const autoMappings = autoDetect ? readLocalPackageDeps(repoPath) : new Map<string, string>();

  // Match imports to repos
  const repoDepMap = new Map<string, ExternalRepoDependency>();
  const unmapped: Set<string> = new Set();
  const primaryRepoSlug = `${diff.owner}/${diff.repo}`;

  for (const imp of allImports) {
    let resolved = false;

    // Check explicit mappings first (higher priority)
    for (const mapping of mappings) {
      if (imp.specifier === mapping.importPrefix || imp.specifier.startsWith(mapping.importPrefix + "/")) {
        if (mapping.repoSlug === primaryRepoSlug) continue; // Skip self-references
        addToRepoDepMap(repoDepMap, mapping.repoSlug, imp, mapping, tokens);
        resolved = true;
        break;
      }
    }

    if (resolved) continue;

    // Check auto-detected mappings (package.json GitHub deps)
    if (autoDetect) {
      // For scoped packages like @scope/name, try both full name and scope
      const autoSlug = autoMappings.get(imp.specifier);
      if (autoSlug && autoSlug !== primaryRepoSlug) {
        addToRepoDepMap(repoDepMap, autoSlug, imp, undefined, tokens);
        resolved = true;
      }
    }

    if (resolved) continue;

    // Go-style imports: "github.com/owner/repo/..."
    const goMatch = imp.specifier.match(/^github\.com\/([^/]+\/[^/]+)/);
    if (goMatch) {
      const slug = goMatch[1];
      if (slug !== primaryRepoSlug) {
        addToRepoDepMap(repoDepMap, slug, imp, undefined, tokens);
        resolved = true;
      }
    }

    if (!resolved) {
      // Only track scoped packages and multi-dot Java imports as "unmapped"
      // (regular npm packages like "axios" or "lodash" are not cross-repo deps)
      if (imp.specifier.startsWith("@") || (imp.specifier.split(".").length > 3)) {
        unmapped.add(imp.specifier);
      }
    }
  }

  const dependencies = Array.from(repoDepMap.values());

  if (dependencies.length > 0) {
    console.log(`  ✅  Resolved ${dependencies.length} cross-repo dependency/ies:`);
    for (const dep of dependencies) {
      console.log(`     • ${dep.repoSlug} (${dep.importSpecifiers.length} import(s), ${dep.detectionMethod})`);
    }
  } else {
    console.log("  ℹ️   No cross-repo dependencies could be mapped to repositories.");
  }

  if (unmapped.size > 0) {
    console.log(`  ⚠️   ${unmapped.size} import(s) detected but unmapped — set MULTI_REPO_MAP to map them:`);
    for (const u of Array.from(unmapped).slice(0, 5)) {
      console.log(`     • ${u}`);
    }
  }

  return {
    dependencies,
    unmappedImports: Array.from(unmapped),
    hasCrossRepoDeps: dependencies.length > 0,
  };
}

function addToRepoDepMap(
  map: Map<string, ExternalRepoDependency>,
  repoSlug: string,
  imp: ExtractedImport,
  mapping: RepoMapping | undefined,
  tokens: Map<string, string>
): void {
  const existing = map.get(repoSlug);
  if (existing) {
    if (!existing.importSpecifiers.includes(imp.specifier)) {
      existing.importSpecifiers.push(imp.specifier);
    }
    existing.importedSymbols.push(...imp.symbols.filter((s) => !existing.importedSymbols.includes(s)));
    if (!existing.referencingFiles.includes(imp.sourceFile)) {
      existing.referencingFiles.push(imp.sourceFile);
    }
  } else {
    const token = mapping?.token || tokens.get(repoSlug) || process.env.GITHUB_TOKEN;
    map.set(repoSlug, {
      repoSlug,
      repoUrl: `https://github.com/${repoSlug}`,
      branch: mapping?.branch || "",
      token,
      importSpecifiers: [imp.specifier],
      importedSymbols: [...imp.symbols],
      referencingFiles: [imp.sourceFile],
      detectionMethod: mapping ? "explicit-mapping" : "auto-detect",
    });
  }
}
