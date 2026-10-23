import axios from "axios";
import * as dns from "dns";
import * as net from "net";
import {
  RequirementConnector,
  ConnectorConfig,
  ConnectorResult,
  NormalizedRequirement,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// External document connector
//
// Fetches PRD documents from URLs — supports Google Docs (export), plain
// text/markdown, and simple HTML pages. Reuses SSRF guards from linkFetcher.ts.
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 8000;

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /^metadata\.google\.internal$/i,
];

function isPrivateIp(host: string): boolean {
  if (!net.isIP(host)) return false;
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
  const h = host.toLowerCase();
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

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
    return { safe: false, reason: "private/internal IP" };
  }
  try {
    const { address } = await dns.promises.lookup(hostname);
    if (isPrivateIp(address)) {
      return { safe: false, reason: `resolves to private address (${address})` };
    }
  } catch {
    // DNS failure will surface again when axios tries to connect
  }
  return { safe: true };
}

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

/** Convert a Google Docs URL to an export URL */
export function toGoogleDocsExportUrl(url: string): string | null {
  // Match Google Docs URLs: docs.google.com/document/d/{ID}/...
  const match = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  return `https://docs.google.com/document/d/${match[1]}/export?format=txt`;
}

/** Extract PRD URLs from text (such as PR description or commit message) */
export function extractPrdUrls(text: string): string[] {
  if (!text) return [];
  const urls: string[] = [];

  // Match: PRD: <url> or PRD: url (case-insensitive)
  const pattern = /\bPRD:\s*(?:<([^>]+)>|([^\s\r\n]+))/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const rawUrl = (match[1] || match[2] || "").trim();
    if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
      const cleanUrl = rawUrl.replace(/[),;.]+$/, "");
      urls.push(cleanUrl);
    }
  }

  // Also match markdown link: [PRD](url)
  const mdPattern = /\[(?:PRD|Spec|Requirements)\]\((https?:\/\/[^\s)]+)\)/gi;
  while ((match = mdPattern.exec(text)) !== null) {
    const rawUrl = match[1].trim();
    if (rawUrl && !urls.includes(rawUrl)) {
      urls.push(rawUrl);
    }
  }

  return Array.from(new Set(urls));
}

/** Extract acceptance criteria from document text */
export function extractAcceptanceCriteria(text: string): string[] {
  const criteria: string[] = [];
  const lines = text.split("\n");
  let inAcSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{0,4}\s*(acceptance\s*criteria|ac|verification|definition\s*of\s*done|requirements?)\b/i.test(trimmed)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && /^#{1,4}\s+[A-Za-z]/.test(trimmed)) {
      inAcSection = false;
    }
    const checkboxMatch = trimmed.match(/^[-*]\s*\[[ xX]\]\s*(.+)$/);
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim());
      continue;
    }
    if (inAcSection && /^[-*•\d+.]\s*(.+)$/.test(trimmed)) {
      const item = trimmed.replace(/^[-*•\s]+/, "").replace(/^\d+[.)]\s*/, "").trim();
      if (item.length > 5) criteria.push(item);
    }
  }

  return criteria;
}

export class ExternalDocConnector implements RequirementConnector {
  readonly name = "External Documents";
  readonly source = "external_url" as const;

  isConfigured(): boolean {
    // Always "configured" — just needs URLs to fetch
    return true;
  }

  async fetch(config: ConnectorConfig): Promise<ConnectorResult> {
    const diagnostics: string[] = [];
    const requirements: NormalizedRequirement[] = [];
    const urls = config.externalDocUrls || [];

    // Also check env var for additional URLs
    const envUrls = process.env.PRD_URLS
      ? process.env.PRD_URLS.split(",").map(u => u.trim()).filter(Boolean)
      : [];
    const allUrls = [...new Set([...urls, ...envUrls])];

    if (allUrls.length === 0) {
      return {
        source: this.source,
        requirements: [],
        success: true,
        diagnostics: ["External doc connector: no URLs configured"],
      };
    }

    for (const url of allUrls) {
      const safety = await isSafeToFetch(url);
      if (!safety.safe) {
        diagnostics.push(`External doc connector: blocked by SSRF guard (${safety.reason}): ${url}`);
        continue;
      }

      try {
        const req = await this.fetchDocument(url);
        if (req) {
          requirements.push(req);
          diagnostics.push(`External doc connector: fetched "${req.title}" from ${url}`);
        } else {
          diagnostics.push(`External doc connector: no content extracted from ${url}`);
        }
      } catch (err: any) {
        diagnostics.push(`External doc connector: failed to fetch ${url}: ${err.message}`);
      }
    }

    const hasUrls = allUrls.length > 0;
    const fetchFailed = hasUrls && requirements.length === 0;

    return {
      source: this.source,
      requirements,
      success: !fetchFailed,
      sourceUnreachable: fetchFailed,
      error: fetchFailed ? "Failed to retrieve requirements from configured external document URL(s)" : undefined,
      diagnostics,
    };
  }

  async fetchDocument(url: string): Promise<NormalizedRequirement | null> {
    const safety = await isSafeToFetch(url);
    if (!safety.safe) {
      console.warn(`  ⚠️   External doc skipped (${safety.reason}): ${url}`);
      return null;
    }

    // Try Google Docs export first
    const gdocsUrl = toGoogleDocsExportUrl(url);
    const fetchUrl = gdocsUrl || url;

    try {
      const res = await axios.get(fetchUrl, {
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { "User-Agent": "myco-prd-validator/1.0 (+requirement-fetch)" },
        responseType: "text",
      });

      if (res.status < 200 || res.status >= 300) {
        return null;
      }

      const contentType = String(res.headers["content-type"] || "");
      if (contentType.includes("application/pdf") || contentType.includes("image/") || contentType.includes("video/")) {
        return null;
      }

      let text: string = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
      if (contentType.includes("html")) {
        text = stripHtml(text);
      }
      text = text.trim();

      if (!text || text.length < 20) return null;
      if (text.length < 40 && /sign in|log in|authentication required/i.test(text)) return null;

      const content = text.slice(0, MAX_EXTRACTED_CHARS);
      const title = extractTitle(content) || new URL(url).pathname.split("/").pop() || "External Document";
      const acceptanceCriteria = extractAcceptanceCriteria(content);

      return {
        id: `EXTDOC-${hashUrl(url)}`,
        source: "external_url",
        title,
        description: `External document: ${title}\nSource: ${url}\n\n${content}`,
        acceptanceCriteria,
        priority: "medium",
        severity: acceptanceCriteria.length > 0 ? "mandatory" : "recommended",
        sourceUrl: url,
        traceability: [],
        sourceKey: url,
        contentExcerpt: content.slice(0, 2000),
      };
    } catch (err: any) {
      return null;
    }
  }
}

function extractTitle(text: string): string | null {
  const lines = text.split("\n");
  for (const line of lines.slice(0, 10)) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) return match[1].trim();
    if (line.trim().length > 5 && line.trim().length < 120 && !line.startsWith("-") && !line.startsWith("*")) {
      return line.trim();
    }
  }
  return null;
}

function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const chr = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}
