import * as fs from "fs";
import * as path from "path";
import { cloneTargetRepo, redactForLog } from "../repo/repoManager";
import { ExternalRepoDependency } from "./multiRepoResolver";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cloned external repository ready for analysis.
 */
export interface ClonedExternalRepo {
  /** GitHub "owner/repo" slug. */
  repoSlug: string;
  /** Absolute local path to the cloned repo. */
  localPath: string;
  /** Branch that was cloned. */
  branch: string;
  /** The dependency metadata that triggered this clone. */
  dependency: ExternalRepoDependency;
  /** Whether the clone succeeded. */
  success: boolean;
  /** Error message if clone failed. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of external repos to clone in a single review run. */
const MAX_EXTERNAL_REPOS = 5;

/** Base directory for multi-repo clones, relative to the working directory. */
const DEFAULT_MULTI_REPO_BASE = "./multi-repo-clones";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clone all resolved external repo dependencies.
 *
 * Reuses the same secure cloning logic from repoManager.ts:
 * - Authenticated sparse clones (depth=1)
 * - Path-traversal protection
 * - Token handling (only for github.com URLs)
 *
 * Each external repo is cloned into its own directory under the multi-repo
 * base path: `<basePath>/<owner>/<repo>/`
 *
 * @param dependencies  Resolved external repo dependencies to clone
 * @param basePath      Base directory for clones (default: ./multi-repo-clones)
 * @returns             Array of clone results (success or failure per repo)
 */
export function cloneExternalRepos(
  dependencies: ExternalRepoDependency[],
  basePath?: string
): ClonedExternalRepo[] {
  const base = path.resolve(basePath || process.env.MULTI_REPO_CLONE_PATH || DEFAULT_MULTI_REPO_BASE);
  const results: ClonedExternalRepo[] = [];

  if (dependencies.length === 0) {
    return results;
  }

  // Enforce the safety limit — a misconfigured MULTI_REPO_MAP with dozens of
  // entries shouldn't consume all runner disk/time. The most important repos
  // are listed first (ordered by number of import references in the resolver).
  const toClone = dependencies
    .sort((a, b) => {
      const scoreA = a.role === "downstream" || a.role === "bidirectional" ? 100 : a.importSpecifiers.length;
      const scoreB = b.role === "downstream" || b.role === "bidirectional" ? 100 : b.importSpecifiers.length;
      return scoreB - scoreA;
    })
    .slice(0, MAX_EXTERNAL_REPOS);

  if (toClone.length < dependencies.length) {
    console.log(
      `  ⚠️   ${dependencies.length} external repos resolved, capping at ${MAX_EXTERNAL_REPOS} most-referenced.`
    );
  }

  console.log(`\n📦  Cloning ${toClone.length} external repo(s) for cross-repo analysis...`);

  // Ensure the base directory exists
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }

  const SAFE_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

  for (const dep of toClone) {
    const [owner, repo] = dep.repoSlug.split("/");
    const isUnsafeSlug =
      !SAFE_SLUG_REGEX.test(dep.repoSlug) ||
      !owner || !repo ||
      owner === "." || owner === ".." || owner.includes("..") ||
      repo === "." || repo === ".." || repo.includes("..");
    const isUnsafeBranch =
      dep.branch.startsWith("-") ||
      (dep.branch.length > 0 && !/^[A-Za-z0-9_./-]+$/.test(dep.branch));

    if (isUnsafeSlug || isUnsafeBranch) {
      console.warn(`  ⚠️   Invalid or unsafe repo slug "${dep.repoSlug}" / branch "${dep.branch}" — skipping.`);
      results.push({
        repoSlug: dep.repoSlug,
        localPath: "",
        branch: dep.branch || "default",
        dependency: dep,
        success: false,
        error: `Unsafe or malformed repo slug/branch: ${dep.repoSlug}`,
      });
      continue;
    }

    // If a valid local directory is already provided (e.g. local multi-repo checkout or test lab),
    // use it directly without performing a network clone.
    if (dep.localPath && fs.existsSync(dep.localPath) && fs.statSync(dep.localPath).isDirectory()) {
      console.log(`  📂  ${dep.repoSlug} using local directory: ${dep.localPath}`);
      results.push({
        repoSlug: dep.repoSlug,
        localPath: path.resolve(dep.localPath),
        branch: dep.branch || "default",
        dependency: dep,
        success: true,
      });
      continue;
    }

    const targetDir = path.resolve(base, owner, repo);

    // Path traversal defense in depth
    if (!targetDir.startsWith(base + path.sep)) {
      console.warn(`  ⚠️   Target directory escapes base path: "${targetDir}" — skipping.`);
      results.push({
        repoSlug: dep.repoSlug,
        localPath: "",
        branch: dep.branch || "default",
        dependency: dep,
        success: false,
        error: `Target directory escapes base path`,
      });
      continue;
    }

    console.log(`  📥  ${dep.repoSlug} (${dep.branch || "default"}) → ${targetDir}`);

    try {
      // Use the same cloneTargetRepo from repoManager.ts — it handles:
      // - Token-authenticated clones (withAuth)
      // - Sparse checkout
      // - Existing directory re-fetch
      // - Argument injection protection (assertSafeArg)
      //
      // We do a full clone (no sparse folders) since we don't know which
      // files the imports point to until we scan the external repo.
      cloneTargetRepo(dep.repoUrl, dep.branch, targetDir, [], dep.token);

      results.push({
        repoSlug: dep.repoSlug,
        localPath: targetDir,
        branch: dep.branch || "default",
        dependency: dep,
        success: true,
      });
      console.log(`  ✅  ${dep.repoSlug} cloned successfully.`);
    } catch (err: any) {
      const message = redactForLog(err.message || String(err));
      console.warn(`  ⚠️   Failed to clone ${dep.repoSlug}: ${message}`);
      results.push({
        repoSlug: dep.repoSlug,
        localPath: targetDir,
        branch: dep.branch || "default",
        dependency: dep,
        success: false,
        error: message,
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  console.log(`  📦  Cloned ${successCount}/${toClone.length} external repo(s).`);

  return results;
}

/**
 * Clean up cloned external repos to free runner disk space.
 * Called at the end of the review run.
 */
export function cleanupExternalRepos(clonedRepos: ClonedExternalRepo[]): void {
  for (const repo of clonedRepos) {
    if (repo.success && repo.localPath && fs.existsSync(repo.localPath)) {
      // Safety guard: never delete existing project-sibling directories that were referenced locally
      if (repo.dependency?.detectionMethod === "project-sibling" && repo.dependency?.localPath === repo.localPath) {
        continue;
      }
      try {
        fs.rmSync(repo.localPath, { recursive: true, force: true });
        // Clean up empty parent directories (e.g. owner dir under base)
        const parent = path.dirname(repo.localPath);
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
          fs.rmdirSync(parent);
        }
      } catch {
        // Best-effort cleanup — runner teardown will handle the rest.
      }
    }
  }
}
