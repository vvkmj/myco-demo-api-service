import * as fs from "fs";
import { execSync } from "child_process";

/**
 * Clone or pull a target repo with optional sparse checkout.
 *
 * If the target directory already exists, fetch + hard-reset to get the
 * latest HEAD of the branch. If that fails (corrupt repo, etc.), delete
 * and re-clone from scratch.
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
  if (fs.existsSync(targetDir)) {
    console.log(`\n📦  Repo exists at ${targetDir} — pulling latest (${branch})...`);
    try {
      execSync(
        `git -C "${targetDir}" fetch --depth=1 && git -C "${targetDir}" reset --hard origin/${branch}`,
        { stdio: "inherit" }
      );
      console.log("✅  Repo up to date.");
      return;
    } catch {
      console.warn("⚠️   Pull failed — deleting and re-cloning...");
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  console.log(`\n📦  Cloning ${repoUrl} (${branch}) into ${targetDir}...`);
  execSync(
    `git clone --depth=1 --filter=blob:none --sparse --branch=${branch} ${repoUrl} "${targetDir}"`,
    { stdio: "inherit" }
  );

  if (sparseFolders.length > 0) {
    const folderArgs = sparseFolders.map((f) => `"${f}"`).join(" ");
    console.log(
      `🗂️   Sparse checkout — ${sparseFolders.length} folder(s):\n` +
        sparseFolders.map((f) => `   • ${f}`).join("\n")
    );
    execSync(`git -C "${targetDir}" sparse-checkout set ${folderArgs}`, {
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
