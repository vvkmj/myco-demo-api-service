import * as fs from "fs";
import { execFileSync } from "child_process";

/**
 * Reject values that could be interpreted as command-line flags by git
 * instead of the positional argument they're meant to be (argument
 * injection). Branch names and repo URLs here can originate from PR
 * metadata, which is attacker-influenceable on public repos / fork PRs.
 */
function assertSafeArg(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`Refusing to run git with ${label} that looks like a flag: "${value}"`);
  }
}

/**
 * Clone or pull a target repo with optional sparse checkout.
 *
 * If the target directory already exists, fetch + hard-reset to get the
 * latest HEAD of the branch. If that fails (corrupt repo, etc.), delete
 * and re-clone from scratch.
 *
 * Uses execFileSync with argument arrays (never a shell string) so branch
 * names / repo URLs pulled from PR metadata can't be interpreted as shell
 * syntax — see the shell-injection note in ARCHITECTURE.md.
 *
 * @param sparseFolders  Repo-relative folder paths to sparse-checkout.
 *                       Pass an empty array to check out the full tree.
 */
export function cloneTargetRepo(
  repoUrl: string,
  branch: string,
  targetDir: string,
  sparseFolders: string[] = []
): void {
  assertSafeArg(repoUrl, "repo URL");
  assertSafeArg(branch, "branch name");

  if (fs.existsSync(targetDir)) {
    console.log(`\n📦  Repo exists at ${targetDir} — pulling latest (${branch})...`);
    try {
      execFileSync("git", ["-C", targetDir, "fetch", "--depth=1"], { stdio: "inherit" });
      execFileSync("git", ["-C", targetDir, "reset", "--hard", `origin/${branch}`], { stdio: "inherit" });
      console.log("✅  Repo up to date.");
      return;
    } catch {
      console.warn("⚠️   Pull failed — deleting and re-cloning...");
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  console.log(`\n📦  Cloning ${repoUrl} (${branch}) into ${targetDir}...`);
  execFileSync(
    "git",
    ["clone", "--depth=1", "--filter=blob:none", "--sparse", "--branch", branch, repoUrl, targetDir],
    { stdio: "inherit" }
  );

  if (sparseFolders.length > 0) {
    console.log(
      `🗂️   Sparse checkout — ${sparseFolders.length} folder(s):\n` +
        sparseFolders.map((f) => `   • ${f}`).join("\n")
    );
    execFileSync("git", ["-C", targetDir, "sparse-checkout", "set", ...sparseFolders], {
      stdio: "inherit",
    });
  }

  console.log("✅  Repo cloned.");
}

/**
 * Derive the unique parent directories of all changed files in a PR.
 * Used to keep the sparse checkout scoped to only the relevant parts of the repo.
 *
 * e.g. "shared/ford/enroller.ts"  →  "shared/ford"
 *      "si/component-test/foo.ts" →  "si/component-test"
 */
export function deriveSparseFolders(
  changedFilenames: string[]
): string[] {
  const folders = new Set<string>();
  for (const filename of changedFilenames) {
    const dir = filename.includes("/")
      ? filename.substring(0, filename.lastIndexOf("/"))
      : ".";
    if (dir && dir !== ".") folders.add(dir);
  }
  return Array.from(folders);
}
