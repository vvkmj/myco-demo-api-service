import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DiffContext, ChangedFile, buildDiffSummary } from "../github/prFetcher";

/**
 * Checks if the given path or URL refers to an existing local folder.
 */
export function isLocalFolder(pathOrUrl?: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return false;
  const clean = pathOrUrl.startsWith("file://")
    ? pathOrUrl.slice(7)
    : pathOrUrl.trim();

  // If it's a GitHub URL, it is not a local folder
  if (/github\.com\/[^/]+\/[^/]+/i.test(clean)) return false;

  try {
    const resolved = path.resolve(clean);
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Derives repository owner and name from folder or git remote origin.
 */
function deriveRepoOwnerAndName(folderPath: string): { owner: string; repo: string } {
  try {
    const remoteUrl = execFileSync(
      "git",
      ["-C", folderPath, "config", "--get", "remote.origin.url"],
      { encoding: "utf-8" }
    ).trim();

    const ghMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (ghMatch) {
      return { owner: ghMatch[1], repo: ghMatch[2] };
    }
  } catch {}

  const dirName = path.basename(path.resolve(folderPath));
  return { owner: "local", repo: dirName };
}

/**
 * Parses raw unified git diff into ChangedFile[] objects.
 */
export function parseRawGitDiff(rawDiff: string): ChangedFile[] {
  if (!rawDiff || rawDiff.trim().length === 0) return [];

  const files: ChangedFile[] = [];
  // Split on "diff --git "
  const rawChunks = rawDiff.split(/^diff --git /m).filter((c) => c.trim().length > 0);

  for (const chunk of rawChunks) {
    const lines = chunk.split("\n");
    const headerLine = lines[0]; // "a/path b/path"
    const fileMatch = headerLine.match(/^a\/(.+?)\s+b\/(.+)$/);
    const filename = fileMatch ? fileMatch[2] : headerLine.split(" ")[1]?.replace(/^b\//, "") || "unknown";

    let status: "added" | "modified" | "removed" = "modified";
    if (chunk.includes("new file mode")) {
      status = "added";
    } else if (chunk.includes("deleted file mode")) {
      status = "removed";
    }

    // Find the start of the first hunk
    const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
    let patch = "";
    let additions = 0;
    let deletions = 0;

    if (hunkStart !== -1) {
      patch = lines.slice(hunkStart).join("\n");
      for (let i = hunkStart; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith("+") && !l.startsWith("+++")) additions++;
        else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
      }
    }

    files.push({
      filename,
      status,
      additions,
      deletions,
      patch: patch || undefined,
    });
  }

  return files;
}

/**
 * Reads local changes from a folder, either from Git (working tree / commits)
 * or by scanning files directly if non-git.
 */
export async function readLocalFolderDiff(
  folderInput: string,
  options: { baseRef?: string; targetBranch?: string } = {}
): Promise<DiffContext> {
  const cleanPath = folderInput.startsWith("file://")
    ? folderInput.slice(7)
    : folderInput.trim();
  const absPath = path.resolve(cleanPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Target folder does not exist: "${absPath}"`);
  }

  const { owner, repo } = deriveRepoOwnerAndName(absPath);
  let isGit = false;
  try {
    const res = execFileSync("git", ["-C", absPath, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf-8",
    }).trim();
    isGit = res === "true";
  } catch {
    isGit = false;
  }

  let headRef = "HEAD";
  let baseRef = options.baseRef || "HEAD~1";
  let author = "local-developer";
  let title = `Local changes in ${repo}`;
  let description = `Review of changes in local folder ${absPath}`;
  const changedFiles: ChangedFile[] = [];

  if (isGit) {
    try {
      headRef = execFileSync("git", ["-C", absPath, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
      }).trim();
      if (headRef === "HEAD") {
        headRef = execFileSync("git", ["-C", absPath, "rev-parse", "--short", "HEAD"], {
          encoding: "utf-8",
        }).trim();
      }
    } catch {}

    try {
      author = execFileSync("git", ["-C", absPath, "config", "user.name"], {
        encoding: "utf-8",
      }).trim() || author;
    } catch {}

    // Check last commit message for context
    try {
      const lastCommit = execFileSync(
        "git",
        ["-C", absPath, "log", "-1", "--pretty=format:%s%n%b"],
        { encoding: "utf-8" }
      ).trim();
      if (lastCommit) {
        title = lastCommit.split("\n")[0];
        description = lastCommit;
      }
    } catch {}

    // 1. Try working tree diff (unstaged + staged changes)
    let rawDiff = "";
    try {
      rawDiff = execFileSync("git", ["-C", absPath, "diff", "HEAD"], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {}

    // 2. If working tree is clean, compare against base branch or HEAD~1
    if (!rawDiff || rawDiff.trim().length === 0) {
      const candidates = [options.baseRef, "main", "master", "HEAD~1"].filter(Boolean) as string[];
      for (const candidate of candidates) {
        try {
          rawDiff = execFileSync("git", ["-C", absPath, "diff", `${candidate}...HEAD`], {
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          if (rawDiff && rawDiff.trim().length > 0) {
            baseRef = candidate;
            break;
          }
        } catch {}
      }
    }

    if (rawDiff && rawDiff.trim().length > 0) {
      changedFiles.push(...parseRawGitDiff(rawDiff));
    }

    // Check for untracked files in the working directory
    try {
      const untracked = execFileSync(
        "git",
        ["-C", absPath, "status", "--porcelain", "-uall"],
        { encoding: "utf-8" }
      )
        .split("\n")
        .filter((l) => l.startsWith("?? "))
        .map((l) => l.slice(3).trim());

      for (const relFile of untracked) {
        const fullFile = path.join(absPath, relFile);
        if (fs.existsSync(fullFile) && fs.statSync(fullFile).isFile()) {
          // Read content as added file
          const content = fs.readFileSync(fullFile, "utf-8");
          const lines = content.split("\n");
          const additions = lines.length;
          const patch = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join("\n");
          changedFiles.push({
            filename: relFile,
            status: "added",
            additions,
            deletions: 0,
            patch,
          });
        }
      }
    } catch {}
  }

  // If still no changes found (e.g. non-git folder or no commits), scan folder directly
  if (changedFiles.length === 0) {
    function walkPlainFolder(dir: string, depth: number) {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "target-repo"
          )
            continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkPlainFolder(full, depth + 1);
          } else if (entry.isFile()) {
            const rel = path.relative(absPath, full).replace(/\\/g, "/");
            const content = fs.readFileSync(full, "utf-8");
            const lines = content.split("\n");
            changedFiles.push({
              filename: rel,
              status: "added",
              additions: lines.length,
              deletions: 0,
              patch: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => `+${l}`).join("\n"),
            });
          }
        }
      } catch {}
    }
    walkPlainFolder(absPath, 1);
  }

  const diffSummary = buildDiffSummary(changedFiles);
  const slug = `local_${repo}_${Date.now()}`;

  return {
    owner,
    repo,
    sourceType: "local",
    title,
    description,
    author,
    baseRef,
    headRef,
    state: "open",
    labels: ["local-review"],
    reviewers: [],
    changedFiles,
    diffSummary,
    commits: [],
    slug,
  };
}
