// ─────────────────────────────────────────────────────────────────────────────
// Shared finding types and parser — used by prCommenter, findingValidator, etc.
// ─────────────────────────────────────────────────────────────────────────────

export interface FindingCard {
  id: string;         // e.g. "BLOCKER-1", "P1-2"
  severity: string;   // "BLOCKER" | "P1" | "P2" | "P3"
  title: string;
  file: string;       // raw "path/to/file.ts · lines X–Y"
  filePath: string;   // just the path portion
  line: number | null;
  rootCause: string;
  impact: string;
  fix: string;
}

/**
 * Parse all finding cards out of the review markdown.
 * Cards follow the format produced by buildReviewPrompt:
 *
 *   ---
 *   **[SEVERITY-N]** Short title
 *   **File:** path/to/file.ts · lines X–Y
 *   **Root cause:** ...
 *   **Impact:** ...
 *   **Fix:** ...
 *   ---
 */
export function parseFindings(reviewMarkdown: string): FindingCard[] {
  const findings: FindingCard[] = [];

  const cardPattern =
    /---\s*\n\*\*\[(BLOCKER|P1|P2|P3)-(\d+)\]\*\*\s+(.+?)\n\*\*File:\*\*\s+(.+?)\n\*\*Root cause:\*\*\s+([\s\S]+?)\n\*\*Impact:\*\*\s+([\s\S]+?)\n\*\*Fix:\*\*\s+([\s\S]+?)\n---/g;

  let match: RegExpExecArray | null;
  while ((match = cardPattern.exec(reviewMarkdown)) !== null) {
    const [, severity, num, title, fileRaw, rootCause, impact, fix] = match;
    const id = `${severity}-${num}`;

    // Extract just the file path (before "·" or "line")
    const filePathMatch = fileRaw.match(/^([^\s·]+)/);
    const filePath = filePathMatch ? filePathMatch[1].trim() : fileRaw.trim();

    // Extract line number (first number after "line" or "lines")
    const lineMatch = fileRaw.match(/lines?\s+(\d+)/i);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : null;

    findings.push({
      id,
      severity,
      title: title.trim(),
      file: fileRaw.trim(),
      filePath,
      line,
      rootCause: rootCause.trim(),
      impact: impact.trim(),
      fix: fix.trim(),
    });
  }

  return findings;
}
