import axios from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangedFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
}

/**
 * Unified diff context — populated by both fetchPRContext and fetchCompareContext.
 * Downstream modules (review, commenter, codeWalker) all consume this type.
 */
export interface DiffContext {
  owner: string;
  repo: string;
  /** Distinguishes a PR from a tag/branch comparison or local folder diff. */
  sourceType: "pr" | "compare" | "local";
  /** PR number — only set when sourceType === "pr". */
  prNumber?: number;
  /** Human-readable title. For compare: "Tag diff: base...head". */
  title: string;
  /** PR body or newline-joined commit messages for compare. */
  description: string;
  /** PR author login — undefined for compare. */
  author?: string;
  /** Base branch/tag/ref. */
  baseRef: string;
  /** Head branch/tag/ref. */
  headRef: string;
  /** PR state — undefined for compare. */
  state?: string;
  labels: string[];
  reviewers: string[];
  changedFiles: ChangedFile[];
  diffSummary: string;
  /** Commits included in the diff — empty for PRs, populated for compare. */
  commits: CommitSummary[];
  /**
   * Safe filesystem slug for naming the output directory.
   * PR:      "pr123"
   * Compare: "v1.2.3..v1.2.4"  (dots and slashes preserved, colons stripped)
   */
  slug: string;
}

/** @deprecated Use DiffContext */
export type PRContext = DiffContext;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * Annotate each line in a unified diff patch with its absolute file line number.
 *
 * Added lines  (+) are prefixed with the new-file line number: `+44: content`
 * Context lines ( ) are prefixed with the new-file line number: ` 44: content`
 * Deleted lines (-) are prefixed with the old-file line number: `-43: content`
 *
 * This lets the LLM cite exact line numbers without having to count from @@ headers,
 * which is the root cause of incorrect line numbers in findings and inline PR comments.
 */
export function annotatePatchWithLineNumbers(patch: string): string {
  const lines = patch.split("\n");
  const annotated: string[] = [];
  let newLine = 0;
  let oldLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart[,oldLen] +newStart[,newLen] @@ [optional context]
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      annotated.push(line); // keep the @@ header unchanged
      continue;
    }

    // "No newline at end of file" marker — pass through unchanged
    if (line === "\\ No newline at end of file") {
      annotated.push(line);
      continue;
    }

    if (line.startsWith("+")) {
      annotated.push(`+${newLine}: ${line.slice(1)}`);
      newLine++;
    } else if (line.startsWith("-")) {
      annotated.push(`-${oldLine}: ${line.slice(1)}`);
      oldLine++;
    } else {
      // Context line (starts with " ") or empty trailing line
      const content = line.length > 0 ? line.slice(1) : "";
      annotated.push(` ${newLine}: ${content}`);
      newLine++;
      oldLine++;
    }
  }

  return annotated.join("\n");
}

/**
 * Cap each file patch at 8 000 chars to keep context manageable
 * while preserving meaningful diff content.
 */
export function buildDiffSummary(files: ChangedFile[]): string {
  const lines: string[] = [];
  for (const f of files) {
    lines.push(
      `### ${f.status.toUpperCase()}: ${f.filename} (+${f.additions}/-${f.deletions})`
    );
    if (f.patch) {
      // Annotate line numbers first, then truncate the annotated text.
      // This ensures line numbers are always accurate even in truncated patches.
      const annotated = annotatePatchWithLineNumbers(f.patch);
      const patch =
        annotated.length > 8000
          ? annotated.slice(0, 8000) + "\n... (truncated — file too large)"
          : annotated;
      lines.push("```diff\n" + patch + "\n```");
    }
  }
  return lines.join("\n\n");
}

function slugify(ref: string): string {
  // Replace characters that are awkward in filenames (colons, spaces) but keep
  // dots, dashes, slashes-as-dots so tag names stay readable.
  return ref.replace(/[:\s]/g, "").replace(/\//g, "-");
}

// ─────────────────────────────────────────────────────────────────────────────
// URL detection
// ─────────────────────────────────────────────────────────────────────────────

function detectUrlType(url: string): "pr" | "compare" | null {
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return "pr";
  if (/github\.com\/[^/]+\/[^/]+\/compare\//.test(url)) return "compare";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PR fetcher
// ─────────────────────────────────────────────────────────────────────────────

function parsePRUrl(url: string): { owner: string; repo: string; number: number } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse GitHub PR URL: ${url}`);
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

async function fetchPRContext(prUrl: string): Promise<DiffContext> {
  const token = process.env.GITHUB_TOKEN;
  const headers = makeHeaders(token);
  const { owner, repo, number } = parsePRUrl(prUrl);
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;

  console.log(`\n🔍  Fetching PR #${number} from ${owner}/${repo}...`);

  const [prRes, filesRes] = await Promise.all([
    axios.get(base, { headers }),
    axios.get(`${base}/files`, { headers, params: { per_page: 100 } }),
  ]);

  const pr = prRes.data;
  const changedFiles: ChangedFile[] = (filesRes.data as any[]).map((f: any) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  return {
    owner,
    repo,
    sourceType: "pr",
    prNumber: number,
    title: pr.title,
    description: pr.body || "",
    author: pr.user?.login || "unknown",
    baseRef: pr.base?.ref || "",
    headRef: pr.head?.ref || "",
    state: pr.state || "open",
    labels: (pr.labels || []).map((l: any) => l.name as string),
    reviewers: [
      ...(pr.requested_reviewers || []).map((r: any) => r.login as string),
      ...(pr.requested_teams || []).map((t: any) => t.name as string),
    ],
    changedFiles,
    diffSummary: buildDiffSummary(changedFiles),
    commits: [],
    slug: `pr${number}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare fetcher  (tag diff / branch diff)
// ─────────────────────────────────────────────────────────────────────────────

function parseCompareUrl(
  url: string
): { owner: string; repo: string; base: string; head: string } {
  // Matches both:
  //   .../compare/v1.2.3...v1.2.4
  //   .../compare/main...feature/my-branch
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/compare\/(.+?)\.\.\.(.+?)(?:[?#].*)?$/);
  if (!match) throw new Error(`Cannot parse GitHub compare URL: ${url}`);
  return { owner: match[1], repo: match[2], base: match[3], head: match[4] };
}

async function fetchCompareContext(compareUrl: string): Promise<DiffContext> {
  const token = process.env.GITHUB_TOKEN;
  const headers = makeHeaders(token);
  const { owner, repo, base, head } = parseCompareUrl(compareUrl);

  console.log(`\n🔍  Fetching compare ${base}...${head} from ${owner}/${repo}...`);

  // The compare endpoint returns metadata + files in one call.
  // For very large diffs (>300 files) GitHub paginates via Link header;
  // we fetch up to 300 files which covers the vast majority of releases.
  const res = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { headers }
  );

  const data = res.data;

  const changedFiles: ChangedFile[] = ((data.files as any[]) || []).map((f: any) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  const commits: CommitSummary[] = ((data.commits as any[]) || []).map((c: any) => ({
    sha: (c.sha as string).slice(0, 8),
    message: (c.commit?.message as string || "").split("\n")[0],
    author: c.commit?.author?.name || c.author?.login || "unknown",
  }));

  // Build a description from commit messages (capped so it doesn't flood the prompt)
  const commitBlock = commits
    .slice(0, 30)
    .map((c) => `- ${c.sha} ${c.author}: ${c.message}`)
    .join("\n");
  const description =
    commits.length > 30
      ? commitBlock + `\n... and ${commits.length - 30} more commits`
      : commitBlock;

  return {
    owner,
    repo,
    sourceType: "compare",
    title: `Tag diff: ${base}...${head}`,
    description,
    baseRef: base,
    headRef: head,
    labels: [],
    reviewers: [],
    changedFiles,
    diffSummary: buildDiffSummary(changedFiles),
    commits,
    slug: `${slugify(base)}..${slugify(head)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point — routes by URL shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch diff context from either a PR URL or a compare URL.
 * Automatically detects which based on the URL pattern.
 */
export async function fetchDiffContext(url: string): Promise<DiffContext> {
  const type = detectUrlType(url);
  if (type === "pr") return fetchPRContext(url);
  if (type === "compare") return fetchCompareContext(url);
  throw new Error(
    `Unrecognised URL format: "${url}"\n` +
    `Expected one of:\n` +
    `  https://github.com/<owner>/<repo>/pull/<number>\n` +
    `  https://github.com/<owner>/<repo>/compare/<base>...<head>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatter
// ─────────────────────────────────────────────────────────────────────────────

export function formatDiffContext(ctx: DiffContext): string {
  const fileList = ctx.changedFiles
    .map((f) => `- \`${f.filename}\` — **${f.status}** (+${f.additions}/-${f.deletions})`)
    .join("\n");

  const labelStr = ctx.labels.length > 0 ? ctx.labels.join(", ") : "_none_";
  const reviewerStr = ctx.reviewers.length > 0 ? ctx.reviewers.join(", ") : "_none_";

  if (ctx.sourceType === "pr") {
    return `## Pull Request #${ctx.prNumber}: ${ctx.title}

**Repo:** ${ctx.owner}/${ctx.repo}
**Author:** ${ctx.author ?? "unknown"}
**Branch:** \`${ctx.headRef}\` → \`${ctx.baseRef}\`
**State:** ${ctx.state ?? "unknown"}
**Labels:** ${labelStr}
**Reviewers:** ${reviewerStr}

### Description
${ctx.description || "_No description provided._"}

### Changed Files (${ctx.changedFiles.length})
${fileList}

### Diff
${ctx.diffSummary}
`;
  }

  if (ctx.sourceType === "local") {
    return `## Local Folder Changes: ${ctx.title}

**Folder / Repo:** ${ctx.owner}/${ctx.repo}
**Author:** ${ctx.author ?? "local"}
**Branch:** \`${ctx.headRef}\` (base: \`${ctx.baseRef}\`)
**Labels:** ${labelStr}

### Description
${ctx.description || "_Local working tree changes._"}

### Changed Files (${ctx.changedFiles.length})
${fileList}

### Diff
${ctx.diffSummary}
`;
  }

  // compare
  const commitList = ctx.commits
    .slice(0, 30)
    .map((c) => `- \`${c.sha}\` **${c.author}**: ${c.message}`)
    .join("\n");
  const moreCommits =
    ctx.commits.length > 30 ? `\n_...and ${ctx.commits.length - 30} more commits_` : "";

  return `## Tag / Branch Diff: \`${ctx.baseRef}\` → \`${ctx.headRef}\`

**Repo:** ${ctx.owner}/${ctx.repo}
**Commits in range:** ${ctx.commits.length}

### Commits
${commitList}${moreCommits}

### Changed Files (${ctx.changedFiles.length})
${fileList}

### Diff
${ctx.diffSummary}
`;
}

/** @deprecated Use formatDiffContext */
export const formatPRContext = formatDiffContext;

