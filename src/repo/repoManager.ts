import * as fs from "fs";
import * as path from "path";
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
 * Embeds a token into a github.com HTTPS URL for git-level auth, the same
 * way actions/checkout does it internally. Deliberately scoped to exactly
 * "github.com" (case-insensitive) — never embed a live token into a URL
 * pointed at an arbitrary host (a misconfigured or attacker-influenced
 * TARGET_REPO could otherwise leak the token to a third party the moment
 * git tries to connect). Returns the URL unchanged if it isn't a github.com
 * https URL, or if no token was given.
 */
export function withAuth(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return repoUrl; // not a well-formed URL (e.g. a local path) — leave it alone
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return repoUrl;
  }
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/** Redacts a possibly-token-embedded URL for safe logging — defense in depth on top of the CI runner's own secret masking, not a replacement for it. */
export function redactForLog(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.password || parsed.username) {
      parsed.username = "***";
      parsed.password = "";
      return parsed.toString();
    }
    return repoUrl;
  } catch {
    return repoUrl;
  }
}

function sanitizeGitError(err: any): Error {
  const msg = (err?.message || String(err)).replace(
    /https:\/\/[^@\s]+@github\.com/gi,
    (m: string) => redactForLog(m)
  );
  const sanitized = new Error(msg);
  if (err?.stack) {
    sanitized.stack = err.stack.replace(
      /https:\/\/[^@\s]+@github\.com/gi,
      (m: string) => redactForLog(m)
    );
  }
  return sanitized;
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
 * @param authToken      Optional token (typically GITHUB_TOKEN) embedded
 *                        into the clone/remote URL for a private
 *                        github.com repo. Without this, cloning a private
 *                        target repo fails with git's own generic
 *                        "could not read Username" error — there is no
 *                        other auth path today (see ARCHITECTURE.md).
 */
export function cloneTargetRepo(
  repoUrl: string,
  branch?: string,
  targetDir: string = "./target-repo",
  sparseFolders: string[] = [],
  authToken?: string
): void {
  assertSafeArg(repoUrl, "repo URL");
  if (branch) {
    assertSafeArg(branch, "branch name");
  }

  const authedUrl = withAuth(repoUrl, authToken);

  try {
    const hasGitSubdir = fs.existsSync(targetDir) && fs.existsSync(path.join(targetDir, ".git"));
    if (hasGitSubdir) {
      console.log(`\n📦  Repo exists at ${targetDir} — pulling latest (${branch || "default"})...`);
      try {
        // Re-set the remote URL every time (cheap, idempotent) so a stale or
        // differently-authed remote from a prior run doesn't cause a
        // confusing auth failure here instead of at clone time.
        execFileSync("git", ["-C", targetDir, "remote", "set-url", "origin", authedUrl], { stdio: "inherit" });
        execFileSync("git", ["-C", targetDir, "fetch", "--depth=1"], { stdio: "inherit" });
        if (branch) {
          execFileSync("git", ["-C", targetDir, "reset", "--hard", `origin/${branch}`], { stdio: "inherit" });
        } else {
          execFileSync("git", ["-C", targetDir, "reset", "--hard", "FETCH_HEAD"], { stdio: "inherit" });
        }
        console.log("✅  Repo up to date.");
        return;
      } catch {
        console.warn("⚠️   Pull failed — deleting and re-cloning...");
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } else if (fs.existsSync(targetDir)) {
      // If targetDir exists but is NOT a git repo, git -C would climb up to the parent .git!
      // Delete it so git clone can cleanly clone into it.
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    console.log(`\n📦  Cloning ${redactForLog(authedUrl)} (${branch || "default"}) into ${targetDir}...`);
    const cloneArgs = ["clone", "--depth=1", "--filter=blob:none", "--sparse"];
    if (branch) {
      cloneArgs.push("--branch", branch);
    }
    cloneArgs.push(authedUrl, targetDir);
    execFileSync("git", cloneArgs, { stdio: "inherit" });

    if (sparseFolders.length > 0) {
      console.log(
        `🗂️   Sparse checkout — ${sparseFolders.length} folder(s):\n` +
          sparseFolders.map((f) => `   • ${f}`).join("\n")
      );
      execFileSync("git", ["-C", targetDir, "sparse-checkout", "set", ...sparseFolders], {
        stdio: "inherit",
      });
    } else {
      // Check out full tree when no sparse folders are specified
      try {
        execFileSync("git", ["-C", targetDir, "sparse-checkout", "disable"], {
          stdio: "inherit",
        });
      } catch {
        // sparse-checkout might not be enabled or git version difference
      }
    }

    console.log("✅  Repo cloned.");
  } catch (err: any) {
    throw sanitizeGitError(err);
  }
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

    // Java imports are package-qualified, so resolving callers and imports
    // requires the module's complete Java source root, not only the changed
    // file's directory.
    const javaRoot = filename.match(/^(.*(?:^|\/)src\/(?:main|test)\/java)(?:\/|$)/);
    if (javaRoot) folders.add(javaRoot[1]);
  }

  // Include standard documentation, specification, and Jira ticket folders
  // so requirement context is checked out and available locally for review.
  const reqDirs = ["docs", "doc", "specs", "spec", "requirements", "jira", ".jira", ".tickets"];
  for (const rd of reqDirs) {
    folders.add(rd);
  }

  return Array.from(folders);
}
