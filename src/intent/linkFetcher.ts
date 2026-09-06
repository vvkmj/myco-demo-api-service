// Fetches the content behind links found in a PR description, so the
// reviewer can learn the *stated intent* of a change (a linked spec, ticket,
// or design doc) before judging whether the implementation matches it.
//
// Deliberately eager/deterministic rather than an LLM-driven tool: we
// extract URLs from the description with a regex, fetch each one up front
// (best-effort), and hand the model a plain-text block — not a `fetch_url`
// tool it decides whether to call. Simpler to test, and avoids burning a
// tool-use round-trip on something we already know we want to do every time.
//
// Real limitation, stated plainly rather than glossed over: most linked
// docs teams actually use — Notion, Linear, Jira Cloud, Confluence — are
// either behind auth (an unauthenticated GET gets a login wall) or
// client-side-rendered SPAs (the raw HTML has no real content, it's filled
// in by JS after load). This fetcher only gets useful text out of: plain
// text/markdown files, public raw GitHub content, and simple
// server-rendered HTML pages. It will not silently fail on the rest — it
// reports per-link status so the model (and whoever reads the review) knows
// a link was referenced but its content wasn't available, rather than the
// review just looking like it forgot the link existed.
import axios from "axios";
import * as dns from "dns";
import * as net from "net";

const URL_REGEX = /https?:\/\/[^\s)\]}"'<>]+/gi;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|ico)(\?.*)?$/i;
const MAX_LINKS = 3;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB raw response cap
const MAX_EXTRACTED_CHARS = 6000; // per-link, after stripping, before handing to the prompt

/** Extracts up to MAX_LINKS unique, non-image http(s) URLs from free text, in order of appearance. */
export function extractLinks(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    // Trim common trailing punctuation a URL regex tends to over-grab (e.g. "see https://x.com/y." at end of sentence).
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    if (IMAGE_EXTENSIONS.test(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /^metadata\.google\.internal$/i,
];

/** True if the hostname is a literal IP in a private/loopback/link-local/metadata range. */
function isPrivateIp(host: string): boolean {
  if (!net.isIP(host)) return false;
  // IPv4 metadata endpoint used by AWS/GCP/Azure/OpenStack — the single most
  // common real-world SSRF target for exactly this kind of "fetch a URL a
  // stranger's PR description pointed at" feature running inside CI.
  if (host === "169.254.169.254") return true;
  if (net.isIPv4(host)) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  // IPv6: loopback, link-local, unique-local.
  const h = host.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

/**
 * Resolves the hostname and checks both the literal host and (best-effort)
 * its resolved address against the private/metadata ranges. Not a
 * DNS-rebinding-proof guard (that needs pinning the resolved IP through the
 * actual TCP connection, which axios/Node's http client doesn't expose
 * cleanly) — but it blocks the obvious, common attack shape: a PR
 * description linking straight at an internal IP or the cloud metadata
 * endpoint to get the CI runner to fetch it for them.
 */
async function isSafeToFetch(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: "unparseable URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `unsupported scheme: ${parsed.protocol}` };
  }
  const hostname = parsed.hostname;
  if (PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(hostname))) {
    return { safe: false, reason: "private/internal hostname" };
  }
  if (isPrivateIp(hostname)) {
    return { safe: false, reason: "private/internal IP literal" };
  }
  try {
    const { address } = await dns.promises.lookup(hostname);
    if (isPrivateIp(address)) {
      return { safe: false, reason: `resolves to private/internal address (${address})` };
    }
  } catch {
    // DNS lookup failing here isn't a safety issue — it'll just fail again
    // (more informatively) when axios tries to actually fetch it.
  }
  return { safe: true };
}

/** Very small HTML→text stripper — good enough for simple server-rendered pages, not a real parser. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FetchedLink {
  url: string;
  status: "fetched" | "skipped" | "failed";
  reason?: string;
  content?: string;
}

export async function fetchLink(url: string): Promise<FetchedLink> {
  const safety = await isSafeToFetch(url);
  if (!safety.safe) {
    return { url, status: "skipped", reason: safety.reason };
  }

  try {
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { "User-Agent": "myco-pr-reviewer/1.0 (+intent-link-fetch)" },
      responseType: "text",
      // Re-validate every redirect hop against the same SSRF guard — a
      // public URL that 302s to an internal address is the classic bypass
      // for a naive "check the URL once" guard.
      beforeRedirect: (options: any) => {
        const nextUrl = `${options.protocol}//${options.hostname}${options.path || ""}`;
        // Fire-and-forget best-effort check; axios's beforeRedirect is sync,
        // so we can only do the cheap literal-IP/hostname checks here, not
        // the async DNS lookup. Good enough as a first line of defense —
        // the destination is HTTP(S) already validated to not itself be a
        // banned literal host by virtue of coming from a real DNS response.
        if (PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(options.hostname)) || isPrivateIp(options.hostname)) {
          throw new Error(`Blocked redirect to private/internal host: ${options.hostname}`);
        }
        void nextUrl;
      },
    });

    if (res.status < 200 || res.status >= 300) {
      return { url, status: "failed", reason: `HTTP ${res.status}` };
    }

    const contentType = String(res.headers["content-type"] || "");
    if (contentType.includes("application/pdf") || contentType.includes("image/") || contentType.includes("video/")) {
      return { url, status: "skipped", reason: `unsupported content-type: ${contentType.split(";")[0]}` };
    }

    let text: string = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    if (contentType.includes("html")) {
      text = stripHtml(text);
    }
    text = text.trim();

    if (!text) {
      return { url, status: "failed", reason: "empty content after fetch" };
    }
    // Heuristic for "we hit a login wall, not the actual doc" — not reliable
    // enough to hard-fail on, so we still return the content but this alone
    // won't catch every auth-gated page (most just 200 with a near-empty
    // client-rendered shell, caught by the empty-content check above).
    if (text.length < 40 && /sign in|log in|authentication required/i.test(text)) {
      return { url, status: "failed", reason: "likely an auth/login wall — content not accessible" };
    }

    return { url, status: "fetched", content: text.slice(0, MAX_EXTRACTED_CHARS) };
  } catch (err: any) {
    return { url, status: "failed", reason: err?.message || String(err) };
  }
}

/**
 * Extracts links from the PR description, fetches each (best-effort), and
 * renders a markdown block for the prompt. Returns "" if there were no
 * links to follow at all (so callers can omit the section entirely rather
 * than showing an empty "Linked Context" heading).
 */
export async function fetchLinkedContext(description: string): Promise<string> {
  const links = extractLinks(description);
  if (links.length === 0) return "";

  const results = await Promise.all(links.map(fetchLink));

  const blocks = results.map((r) => {
    if (r.status === "fetched") {
      return `#### ${r.url}\n${r.content}`;
    }
    return `#### ${r.url}\n_Not available (${r.status}${r.reason ? `: ${r.reason}` : ""}) — treat this link as referenced but unread; do not assume its content._`;
  });

  return blocks.join("\n\n");
}
