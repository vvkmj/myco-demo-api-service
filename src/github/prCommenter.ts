import axios from "axios";
import { DiffContext } from "./prFetcher";
import { FindingCard, parseFindings } from "../review/finding";
import { ValidatedFinding } from "../validate/findingValidator";

// ─────────────────────────────────────────────────────────────────────────────
// Already-raised deduplication types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of findings that have already been raised in the PR from a previous
 * Myco run. Used to suppress duplicate inline comments and ticket creation.
 */
export interface AlreadyRaisedResult {
  /** file:line positions where a non-bot dev has replied to a Myco comment. */
  acknowledgedPositions: Set<string>;
  /** file:line → ticketUrl for inline threads whose bot comment already contains a ticket link. */
  ticketedByPosition: Map<string, string>;
  /** findingId (e.g. "P1-3") → ticketUrl, from "Jira Tickets Filed" issue comments. */
  ticketedById: Map<string, string>;
}

/** One-liner for inline review thread comments. */
function formatInlineComment(finding: FindingCard): string {
  return `**[${finding.id}] ${finding.title}**\n\`${finding.file}\``;
}

/** One-liner for confirmed inline comments (includes verdict and ticket link if available). */
function formatConfirmedInlineComment(finding: ValidatedFinding): string {
  const blocking = finding.mergeBlocking ? " · Merge-blocking" : "";
  const ticket = finding.ticketUrl ? `\n> [Jira ticket](${finding.ticketUrl})` : "";
  return (
    `**[${finding.id}] ${finding.title}**\n` +
    `\`${finding.file}\`\n` +
    `> ${finding.verdict} · ${finding.confidence}${blocking}${ticket}`
  );
}

/** Inline comment for UNCERTAIN findings — flagged for human review. */
function formatUncertainInlineComment(finding: ValidatedFinding): string {
  return (
    `**[${finding.id}] ${finding.title}**\n` +
    `\`${finding.file}\`\n` +
    `> UNCERTAIN · ${finding.confidence} — Flagged for human review\n` +
    `> ${finding.validatorReasoning}`
  );
}

/** Compact markdown table row for a finding. */
function tableRow(f: FindingCard): string {
  const loc = f.line ? `\`${f.filePath}:${f.line}\`` : `\`${f.filePath}\``;
  return `| **[${f.id}]** | ${f.severity} | ${f.title} | ${loc} |`;
}

/** Compact markdown table row for a validated finding, including Jira ticket link. */
function validatedTableRow(f: ValidatedFinding): string {
  const loc = f.line ? `\`${f.filePath}:${f.line}\`` : `\`${f.filePath}\``;
  const blocking = f.mergeBlocking ? " · Merge-blocking" : "";
  const ticket = f.ticketUrl ? `[link](${f.ticketUrl})` : "—";
  return `| **[${f.id}]** | ${f.severity} | ${f.title} | ${loc} | ${f.verdict} · ${f.confidence}${blocking} | ${ticket} |`;
}

/**
 * Post all findings as a GitHub PR review.
 *
 * BLOCKER/P1/P2 findings that include a file + line are attempted as inline
 * review comments. If GitHub rejects any of them (422 — the referenced line is
 * not in the diff), the whole review is retried as a body-only comment so that
 * findings are never silently lost.
 *
 * All findings (BLOCKER through P3) are always included in the review body so
 * the body is a complete, standalone report regardless of whether inline
 * comments succeed.
 *
 * Throws if called with a non-PR DiffContext.
 * Returns the total number of findings posted.
 */
export async function postReviewComments(
  diff: DiffContext,
  reviewMarkdown: string,
  token: string
): Promise<number> {
  if (diff.sourceType !== "pr" || diff.prNumber == null) {
    throw new Error(
      "postReviewComments can only be called for PR inputs (sourceType === 'pr'). " +
      "Tag/branch compare diffs have no associated PR to comment on."
    );
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const base = `https://api.github.com/repos/${diff.owner}/${diff.repo}`;

  // Get the latest commit SHA for the PR head (required for review comments)
  const prRes = await axios.get(`${base}/pulls/${diff.prNumber}`, { headers });
  const headSha: string = prRes.data.head.sha;

  const findings = parseFindings(reviewMarkdown);

  if (findings.length === 0) {
    console.log("  ℹ️   No structured finding cards found in review — nothing to post.");
    return 0;
  }

  // Inline candidates: BLOCKER/P1/P2 with a resolvable file path and line number.
  // These become inline review thread comments if GitHub accepts the line refs.
  const inlineFindings = findings.filter(
    (f) =>
      (f.id.startsWith("BLOCKER") || f.id.startsWith("P1")) &&
      f.filePath &&
      f.line !== null
  );
  const bodyOnlyFindings = findings.filter((f) => !inlineFindings.includes(f));

  // ── Build the review body ──────────────────────────────────────────────────
  const TABLE_HEADER =
    `| ID | Severity | Title | Location |\n` +
    `|---|---|---|---|`;

  const allFindings = [...inlineFindings, ...bodyOnlyFindings];
  const reviewBody =
    allFindings.length > 0
      ? `## Findings (${allFindings.length})\n\n${TABLE_HEADER}\n` +
        allFindings.map((f) => tableRow(f)).join("\n")
      : "PR review by SDET Agent — no structured findings.";

  // ── Build inline comment objects ───────────────────────────────────────────
  const inlineComments = inlineFindings.map((f) => ({
    path: f.filePath,
    line: f.line as number,
    side: "RIGHT",
    body: formatInlineComment(f),
  }));

  // ── Post the review ────────────────────────────────────────────────────────
  // Try with inline comments first. If GitHub returns 422 (the line numbers
  // from the LLM review are not part of the diff), fall back to a body-only
  // review. The body already contains all findings so nothing is lost.
  try {
    await axios.post(
      `${base}/pulls/${diff.prNumber}/reviews`,
      {
        commit_id: headSha,
        body: reviewBody,
        event: "COMMENT",
        comments: inlineComments,
      },
      { headers }
    );
    console.log(
      `  ✅  Review posted — ${inlineComments.length} inline comment(s) + body.`
    );
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 422) {
      console.log(
        "  ⚠️   Inline comments rejected by GitHub (line numbers not in diff) — " +
        "retrying as body-only review..."
      );
      await axios.post(
        `${base}/pulls/${diff.prNumber}/reviews`,
        {
          commit_id: headSha,
          body: reviewBody,
          event: "COMMENT",
          comments: [],
        },
        { headers }
      );
      console.log("  ✅  Body-only review posted successfully.");
    } else {
      throw err;
    }
  }

  return findings.length;
}

/**
 * Post a GitHub PR review for all confirmed findings.
 *
 * All CONFIRMED findings are included regardless of severity. FALSE_POSITIVE
 * and UNCERTAIN findings are excluded. Findings with a resolvable file + line
 * are posted as inline review thread comments. If GitHub rejects the line refs
 * (422), falls back to a body-only review so nothing is lost.
 *
 * Uses REQUEST_CHANGES when any confirmed finding is merge-blocking, so
 * GitHub itself blocks the merge until a maintainer dismisses the review.
 *
 * Returns the number of confirmed findings posted.
 */
export async function postConfirmedInlineComments(
  diff: DiffContext,
  findings: ValidatedFinding[],
  token: string,
  alreadyRaised?: AlreadyRaisedResult
): Promise<number> {
  if (diff.sourceType !== "pr" || diff.prNumber == null) return 0;

  const confirmed = findings.filter((f) => f.verdict === "CONFIRMED");
  const uncertain = findings.filter((f) => f.verdict === "UNCERTAIN");
  if (confirmed.length === 0 && uncertain.length === 0) {
    console.log("  ℹ️   No confirmed or uncertain findings — skipping inline comment post.");
    return 0;
  }

  // Filter out findings that already have a ticket in the PR (from a previous run).
  // These are detected via "Jira Tickets Filed" issue comments (by finding ID) or
  // the inline bot comment itself containing "[Jira ticket](url)" (by file:line).
  const isAlreadyTicketed = (f: ValidatedFinding): boolean => {
    if (!alreadyRaised) return false;
    if (alreadyRaised.ticketedById.has(f.id)) return true;
    const pos = f.filePath && f.line != null ? `${f.filePath}:${f.line}` : null;
    return pos != null && alreadyRaised.ticketedByPosition.has(pos);
  };

  const ticketed = confirmed.filter(isAlreadyTicketed);
  if (ticketed.length > 0) {
    console.log(
      `  ℹ️   Skipping ${ticketed.length} finding(s) already raised in PR (ticket exists): ` +
      ticketed.map((f) => `[${f.id}]`).join(", ")
    );
  }

  const toPost = confirmed.filter((f) => !isAlreadyTicketed(f));

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const base = `https://api.github.com/repos/${diff.owner}/${diff.repo}`;
  const prRes = await axios.get(`${base}/pulls/${diff.prNumber}`, { headers });
  const headSha: string = prRes.data.head.sha;

  // Skip findings whose file+line already has a Myco comment with a developer reply.
  // Use acknowledgedPositions from alreadyRaised if available (avoids a second API call),
  // otherwise fall back to fetching them now.
  const acknowledged = alreadyRaised?.acknowledgedPositions ?? await fetchAcknowledgedPositions(diff, token);
  if (acknowledged.size > 0) {
    const skipped = toPost.filter(
      (f) => f.filePath && f.line !== null && acknowledged.has(`${f.filePath}:${f.line}`)
    );
    if (skipped.length > 0) {
      console.log(
        `  ℹ️   Skipping ${skipped.length} finding(s) already acknowledged by developers: ` +
        skipped.map((f) => `[${f.id}]`).join(", ")
      );
    }
  }

  // Uncertain findings to post as inline comments — skip any already acknowledged.
  const uncertainToPost = uncertain.filter(
    (f) => !(f.filePath && f.line !== null && acknowledged.has(`${f.filePath}:${f.line}`))
  );

  if (toPost.length === 0 && uncertainToPost.length === 0) {
    console.log("  ℹ️   All findings already raised in PR — no new inline comments to post.");
    return 0;
  }

  // Build inline comment objects for new confirmed findings that have file + line
  const confirmedInlineComments = toPost
    .filter((f) => f.filePath && f.line !== null)
    .filter((f) => !acknowledged.has(`${f.filePath}:${f.line}`))
    .map((f) => ({
      path: f.filePath,
      line: f.line as number,
      side: "RIGHT" as const,
      body: formatConfirmedInlineComment(f),
    }));

  // Build inline comment objects for uncertain findings that have file + line
  const uncertainInlineComments = uncertainToPost
    .filter((f) => f.filePath && f.line !== null)
    .map((f) => ({
      path: f.filePath,
      line: f.line as number,
      side: "RIGHT" as const,
      body: formatUncertainInlineComment(f),
    }));

  const inlineComments = [...confirmedInlineComments, ...uncertainInlineComments];

  // Build review body: confirmed section + uncertain/flagged section
  const CONFIRMED_TABLE_HEADER =
    `| ID | Severity | Title | Location | Verdict | Ticket |\n` +
    `|---|---|---|---|---|---|`;
  const UNCERTAIN_TABLE_HEADER =
    `| ID | Severity | Title | Location |\n` +
    `|---|---|---|---|`;

  const confirmedSection = toPost.length > 0
    ? `## Confirmed Bugs (${toPost.length})\n\n` +
      CONFIRMED_TABLE_HEADER + "\n" +
      toPost.map((f) => validatedTableRow(f)).join("\n")
    : "";

  const uncertainSection = uncertainToPost.length > 0
    ? `## Flagged for Human Review (${uncertainToPost.length})\n\n` +
      `> These findings could not be confirmed automatically and require manual inspection.\n\n` +
      UNCERTAIN_TABLE_HEADER + "\n" +
      uncertainToPost.map((f) => tableRow(f)).join("\n")
    : "";

  const reviewBody = [confirmedSection, uncertainSection].filter(Boolean).join("\n\n");

  // Use REQUEST_CHANGES if any new confirmed finding is merge-blocking — this
  // causes GitHub to visually block the PR until the review is dismissed.
  const hasBlocker = toPost.some((f) => f.mergeBlocking);
  const event = hasBlocker ? "REQUEST_CHANGES" : "COMMENT";

  try {
    await axios.post(
      `${base}/pulls/${diff.prNumber}/reviews`,
      { commit_id: headSha, body: reviewBody, event, comments: inlineComments },
      { headers }
    );
    console.log(
      `  ✅  Review posted (${event}) — ${confirmedInlineComments.length} confirmed + ` +
      `${uncertainInlineComments.length} uncertain inline comment(s).`
    );
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 422) {
      console.log(
        "  ⚠️   Inline comments rejected by GitHub (line numbers not in diff) — " +
          "retrying as body-only review..."
      );
      await axios.post(
        `${base}/pulls/${diff.prNumber}/reviews`,
        { commit_id: headSha, body: reviewBody, event, comments: [] },
        { headers }
      );
      console.log("  ✅  Body-only review posted successfully.");
    } else {
      throw err;
    }
  }

  return toPost.length + uncertainToPost.length;
}

/**
 * Post a single PR issue comment listing all Jira tickets that were created
 * for confirmed findings. No-ops if no findings have a ticketUrl.
 *
 * Uses the Issues comments API (not the Reviews API) so it always succeeds
 * regardless of diff line positions.
 */
export async function postTicketLinks(
  diff: DiffContext,
  findings: ValidatedFinding[],
  token: string
): Promise<void> {
  if (diff.sourceType !== "pr" || diff.prNumber == null) return;

  const ticketed = findings.filter((f) => f.ticketUrl);
  if (ticketed.length === 0) return;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const rows = ticketed
    .map((f) => `- **[${f.id}]** ${f.title} — [${f.ticketUrl}](${f.ticketUrl})`)
    .join("\n");

  const body =
    `## Jira Tickets Filed\n\n` +
    rows;

  await axios.post(
    `https://api.github.com/repos/${diff.owner}/${diff.repo}/issues/${diff.prNumber}/comments`,
    { body },
    { headers }
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Pagination helper
// ─────────────────────────────────────────────────────────────────────────────

async function paginateComments(
  url: string,
  headers: Record<string, string>
): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const res = await axios.get(url, { headers, params: { per_page: 100, page } });
    if (res.data.length === 0) break;
    all.push(...res.data);
    if (res.data.length < 100) break;
    page++;
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Already-raised finding detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan all existing PR comments (inline review threads + issue comments) to
 * detect findings that were already raised in a previous Myco run.
 *
 * Two detection sources:
 *  1. "## Jira Tickets Filed" issue comments — parse finding IDs + ticket URLs.
 *  2. Inline Myco bot comment threads — check the bot comment for a
 *     "[Jira ticket](url)" link, and fall back to scanning reply text for
 *     known ticket URL patterns (Jira / Linear / GitHub issues).
 *
 * Returns an AlreadyRaisedResult that callers use to suppress re-commenting
 * and re-ticketing for findings that are already addressed.
 */
export async function fetchAlreadyRaisedFindings(
  diff: DiffContext,
  token: string
): Promise<AlreadyRaisedResult> {
  const result: AlreadyRaisedResult = {
    acknowledgedPositions: new Set(),
    ticketedByPosition: new Map(),
    ticketedById: new Map(),
  };

  if (diff.sourceType !== "pr" || diff.prNumber == null) return result;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${diff.owner}/${diff.repo}`;

  // Fetch inline review comments and PR issue comments in parallel
  const [reviewComments, issueComments] = await Promise.all([
    paginateComments(`${base}/pulls/${diff.prNumber}/comments`, headers),
    paginateComments(`${base}/issues/${diff.prNumber}/comments`, headers),
  ]);

  // ── 1. Parse "Jira Tickets Filed" issue comments ──────────────────────────
  // Format: "- **[P1-3]** Title — [https://...](https://...)"
  // The separator is an em dash (U+2014).
  const TICKET_LINE_RE = /\*\*\[([A-Z0-9]+-\d+)\]\*\*[^—\n]*—\s*\[([^\]]+)\]\(([^)]+)\)/g;
  for (const c of issueComments) {
    if (!c.body?.includes("## Jira Tickets Filed")) continue;
    TICKET_LINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TICKET_LINE_RE.exec(c.body)) !== null) {
      // m[1] = findingId, m[3] = ticketUrl
      result.ticketedById.set(m[1], m[3]);
    }
  }

  // ── 2. Process inline review comment threads ───────────────────────────────
  // Build a fast id → comment index for thread walking.
  const byId = new Map<number, any>();
  for (const c of reviewComments) byId.set(c.id, c);

  // Walk in_reply_to_id chain to find the thread root.
  function findRoot(commentId: number): number {
    const visited = new Set<number>();
    let cur = commentId;
    while (true) {
      if (visited.has(cur)) return cur; // cycle guard
      visited.add(cur);
      const parent = byId.get(cur);
      if (!parent?.in_reply_to_id) return cur;
      cur = parent.in_reply_to_id;
    }
  }

  // Group all comments by their thread root.
  const threads = new Map<number, any[]>();
  for (const c of reviewComments) {
    const rootId = c.in_reply_to_id ? findRoot(c.id) : c.id;
    if (!threads.has(rootId)) threads.set(rootId, []);
    threads.get(rootId)!.push(c);
  }

  // Regex that matches known ticket URL prefixes (Jira, Linear, GitHub issues).
  const TICKET_URL_RE =
    /https?:\/\/(?:[^\s)>\]]+\.atlassian\.net\/browse\/|linear\.app\/[^\s)>\]]+\/issue\/|github\.com\/[^\s)>\]]+\/issues\/\d+)[^\s)>\]]*/;

  for (const [rootId, thread] of threads) {
    const root = byId.get(rootId);
    if (!root || !root.path || root.line == null) continue;

    // Only process threads started by a Myco bot comment.
    if (root.user?.type !== "Bot" || !root.body?.includes("**[")) continue;

    const position = `${root.path}:${root.line}`;

    // Check for developer replies (acknowledged).
    const hasDevReply = thread.some((c) => c.id !== rootId && c.user?.type !== "Bot");
    if (hasDevReply) result.acknowledgedPositions.add(position);

    // Primary check: the bot's own comment carries "[Jira ticket](url)" when a
    // ticket was already created for this finding in a previous run.
    const inlineTicketMatch = root.body.match(/\[Jira ticket\]\(([^)]+)\)/);
    if (inlineTicketMatch) {
      result.ticketedByPosition.set(position, inlineTicketMatch[1]);
      continue;
    }

    // Fallback: scan all reply bodies for a recognisable ticket URL.
    const replyText = thread
      .filter((c) => c.id !== rootId)
      .map((c) => c.body ?? "")
      .join("\n");
    const urlMatch = replyText.match(TICKET_URL_RE);
    if (urlMatch) {
      result.ticketedByPosition.set(position, urlMatch[0]);
    }
  }

  return result;
}

/**
 * Fetch file+line positions of existing bot (Myco) inline review comments
 * that have received at least one reply from a non-bot developer.
 *
 * Returns a Set of "filePath:line" strings. Findings whose position appears
 * in this set have already been acknowledged by a developer and should not
 * be re-commented on subsequent Myco runs.
 */
async function fetchAcknowledgedPositions(
  diff: DiffContext,
  token: string
): Promise<Set<string>> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${diff.owner}/${diff.repo}`;

  // Paginate through all review comments on the PR
  const allComments: any[] = [];
  let page = 1;
  while (true) {
    const res = await axios.get(`${base}/pulls/${diff.prNumber}/comments`, {
      headers,
      params: { per_page: 100, page },
    });
    if (res.data.length === 0) break;
    allComments.push(...res.data);
    if (res.data.length < 100) break;
    page++;
  }

  // Build an index for quick lookup: id -> comment
  const byId = new Map<number, any>();
  for (const c of allComments) byId.set(c.id, c);

  // For each reply, walk up the in_reply_to chain to find the thread root
  function findRoot(commentId: number): number {
    const visited = new Set<number>();
    let cur = commentId;
    while (true) {
      if (visited.has(cur)) return cur; // cycle guard
      visited.add(cur);
      const parent = byId.get(cur);
      if (!parent?.in_reply_to_id) return cur;
      cur = parent.in_reply_to_id;
    }
  }

  // Map rootId -> array of user types for all replies (excluding the root itself)
  const replyUserTypes = new Map<number, string[]>();
  for (const c of allComments) {
    if (!c.in_reply_to_id) continue; // skip roots
    const rootId = findRoot(c.id);
    if (!replyUserTypes.has(rootId)) replyUserTypes.set(rootId, []);
    replyUserTypes.get(rootId)!.push(c.user?.type ?? "User");
  }

  const acknowledged = new Set<string>();

  for (const c of allComments) {
    if (c.in_reply_to_id) continue;                       // only thread roots
    if (c.user?.type !== "Bot") continue;                 // only bot comments
    if (!c.body?.includes("**[")) continue;               // only Myco-format comments
    if (!c.path || c.line == null) continue;              // must have a file+line position

    const repliers = replyUserTypes.get(c.id) ?? [];
    const hasDevReply = repliers.some((type) => type !== "Bot");
    if (!hasDevReply) continue;

    acknowledged.add(`${c.path}:${c.line}`);
  }

  return acknowledged;
}
