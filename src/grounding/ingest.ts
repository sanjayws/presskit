/**
 * Grounding ingest. Fetch a URL or accept an uploaded doc, strip to clean
 * readable text, hash the text, store the text to R2. A run later refuses if
 * nothing here resolves. Fetch-and-stuff — no embeddings, no vector DB.
 */
import type { Env } from "../env";
import { groundingDocs, type GroundingDoc } from "../db/repos";
import { RetryableError, isRetryableStatus } from "../errors";
import { extractDocumentMarkdown } from "../openai/extract";
import { completeText, extractOffice, OFFICE_MIMES, MAX_SOURCE_BYTES } from "./documents";
import { renderSourcePage } from "./browser";
import { sourcePrompt, type GroundingEvidence } from "./evidence";
import { MAX_EXTRACTED_CHARS } from "./limits";

const MAX_FETCH_BYTES = MAX_SOURCE_BYTES;
const MAX_TEXT_CHARS = MAX_EXTRACTED_CHARS;

/** SHA-256 hex of a string. Stable content hash. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Reduce an HTML (or plain text) document to clean readable text.
 * Drops script/style/noscript, strips tags, decodes common entities,
 * collapses whitespace. Deterministic and dependency-free so it is unit-testable.
 */
export function htmlToText(input: string): string {
  let s = input;
  // Prefer the readable article, avoiding menus/cookie banners in the evidence budget.
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(s)?.[1]
    ?? ((s.match(/<article\b/gi)?.length ?? 0) === 1 ? /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(s)?.[1] : undefined);
  if (main && main.replace(/<[^>]*>/g, "").trim().length >= 80) s = main;
  s = s.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  // Remove whole non-content elements including their contents.
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ");
  // Comments.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Turn block boundaries into newlines so words don't fuse together.
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|br|tr|header|footer)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode a handful of entities + numeric ones. Guard the codepoint range:
  // String.fromCodePoint throws on values > 0x10FFFF, which would otherwise
  // crash (and permanently fail) ingestion on malformed input.
  const fromCp = (n: number) =>
    Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
  s = s.replace(/&#(\d+);/g, (_m, n) => fromCp(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, n) => fromCp(parseInt(n, 16)));
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
  // Collapse whitespace, keep paragraph breaks.
  s = s.replace(/[ \t\f\r]+/g, " ");
  // Drop spaces introduced (by tag stripping) directly before punctuation.
  s = s.replace(/ +([.,;:!?)])/g, "$1");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
  if (s.length > MAX_TEXT_CHARS) throw new Error("This source is too long to extract completely. Upload the relevant pages or a shorter text excerpt.");
  return s;
}

export interface IngestResult {
  doc: GroundingDoc;
  text: string;
}

function r2KeyFor(campaignId: string, hash: string): string {
  return `grounding/${campaignId}/${hash}.txt`;
}

const FETCH_TIMEOUT_MS = 20_000;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "text/markdown", "text/csv", "application/xhtml+xml", "application/pdf", ...Object.values(OFFICE_MIMES)];

/**
 * Validate a grounding URL before fetching (SSRF policy). http/https only, no
 * embedded credentials, standard ports, and no localhost / private / reserved
 * hosts. Throws on any violation.
 */
export function validateGroundingUrl(raw: string): URL {
  if (raw.length > 4096) throw new Error("Keep each grounding URL to 4,096 characters or fewer.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid grounding url: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`grounding url must be http(s): ${raw}`);
  }
  if (u.username || u.password) {
    throw new Error("grounding url must not contain credentials");
  }
  if (u.port && u.port !== "80" && u.port !== "443") {
    throw new Error(`grounding url port not allowed: ${u.port}`);
  }
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^(0|192\.0|192\.2|198\.18|198\.19|198\.51\.100|203\.0\.113|22[4-9]|23\d|24\d|25\d)\./.test(host) ||
    host.startsWith("[") ||
    host.endsWith(".local") ||
    !host.includes(".");
  if (blocked) throw new Error(`grounding url host not allowed: ${host}`);
  return u;
}

/** Read a response body as text, aborting if it exceeds maxBytes. */
async function readCappedBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("grounding url exceeds size cap");
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) {
    buf.set(ch, o);
    o += ch.length;
  }
  return buf;
}

const MAX_REDIRECTS = 4;

/**
 * Fetch with a bounded MANUAL redirect loop: every hop (including each 3xx
 * destination) is re-validated against the same SSRF/host policy, so a permitted
 * public URL cannot redirect us into a private host/port. One aggregate timeout
 * spans the whole chain.
 */
async function fetchWithRedirectPolicy(startUrl: string): Promise<Response> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); // one budget for the chain
  let current = validateGroundingUrl(startUrl).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      headers: { "user-agent": "ArticleGenerator/1.0 (+grounding)" },
      redirect: "manual",
      signal,
    });
    // 3xx with a Location: validate the destination, then follow it ourselves.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error(`grounding url redirect had no location: ${current}`);
      if (hop === MAX_REDIRECTS) {
        throw new Error(`grounding url exceeded ${MAX_REDIRECTS} redirects: ${startUrl}`);
      }
      const next = new URL(location, current).toString(); // resolve relative Location
      current = validateGroundingUrl(next).toString(); // re-apply full host/port/scheme policy
      continue;
    }
    return res;
  }
  // Unreachable (the loop returns or throws), but satisfies the type checker.
  throw new Error(`grounding url redirect handling failed: ${startUrl}`);
}

/** Fetch a URL (with SSRF policy + limits), clean it, store it. */
export async function ingestUrl(env: Env, campaignId: string, url: string): Promise<IngestResult> {
  return store(env, campaignId, "url", url, await readUrlContent(env, url));
}

/** Read using the same URL, redirect and size policy without persisting a campaign. */
export async function readUrlContent(env: Env, url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithRedirectPolicy(url);
  } catch (e) {
    // A blocked (redirect) destination is a policy violation, not transient: only
    // network/timeout errors should retry. Every validateGroundingUrl / redirect
    // policy message contains "grounding url"; re-throw those as permanent.
    if (e instanceof Error && !(e instanceof RetryableError) && /grounding url/.test(e.message)) {
      throw e;
    }
    // Network/timeout is transient: allow the pipeline to retry.
    throw new RetryableError(`grounding url fetch failed: ${url} (${String(e)})`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 403 && env.BROWSER) {
      const rendered = htmlToText(await renderSourcePage(env, url));
      if (isUsableWebText(rendered)) return rendered;
    }
    if (isRetryableStatus(res.status)) {
      throw new RetryableError(`grounding url ${res.status}: ${url}`);
    }
    throw new Error(`grounding url returned ${res.status}: ${url}`);
  }
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype && !ALLOWED_CONTENT_TYPES.some((t) => ctype.includes(t))) {
    await res.body?.cancel();
    throw new Error(`grounding url content-type not allowed (${ctype}): ${url}`);
  }
  const bytes = await readCappedBytes(res, MAX_FETCH_BYTES);
  const pdf = ctype.includes("application/pdf") || new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  const extension = new URL(url).pathname.match(/\.(docx?|xlsx?|pptx?)$/i)?.[1]?.toLowerCase()
    || Object.entries(OFFICE_MIMES).find(([, mime]) => ctype.includes(mime))?.[0];
  const html = new TextDecoder().decode(bytes);
  let text = pdf ? await extractPdf(env, bytes) : extension ? await extractOffice(env, `source.${extension}`, bytes) : htmlToText(html);
  if (!pdf && !extension && env.BROWSER && (!isUsableWebText(text) || text.length < 200 && /<script\b/i.test(html))) {
    text = htmlToText(await renderSourcePage(env, res.url || url, html));
  }
  if (text.length < 40) {
    throw new Error(`grounding url produced no usable text: ${url}`);
  }
  if (!isUsableWebText(text)) {
    throw new Error("grounding url requires a browser or blocks automated access");
  }
  return text;
}

function isUsableWebText(text: string): boolean {
  return text.length >= 40 && !(text.length < 2000 && /(?:just a moment|access denied|checking your browser|enable javascript|verify you are human|checking if the site connection is secure)/i.test(text));
}

/** Accept an uploaded document body (already read as text) and store it. */
export async function ingestUpload(
  env: Env,
  campaignId: string,
  filename: string,
  body: string | ArrayBuffer,
): Promise<IngestResult> {
  if (typeof body !== "string" && /\.(docx?|xlsx?|pptx?)$/i.test(filename)) {
    return store(env, campaignId, "upload", filename, await extractOffice(env, filename, new Uint8Array(body)));
  }
  if (typeof body !== "string") return store(env, campaignId, "upload", filename, await extractPdf(env, new Uint8Array(body)));
  return store(env, campaignId, "upload", filename, uploadText(body));
}

/** Shared deterministic validation for submission and background ingestion. */
export function uploadText(raw: string): string {
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  return completeText(looksHtml ? htmlToText(raw) : raw);
}

export async function extractPdf(env: Env, data: Uint8Array): Promise<string> {
  if (data.byteLength > MAX_FETCH_BYTES || new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-") throw new Error("The PDF is invalid or exceeds the size cap");
  return extractDocumentMarkdown(env, { filename: "source.pdf", pdf: data });
}

async function store(
  env: Env,
  campaignId: string,
  kind: "url" | "upload",
  source: string,
  text: string,
): Promise<IngestResult> {
  const hash = await sha256Hex(text);
  // Dedup on content hash: identical grounding re-ingested (replay/edit) reuses
  // the existing row and R2 object instead of creating duplicates.
  const existing = await groundingDocs.byHash(env.DB, campaignId, hash);
  if (existing) return { doc: existing, text };

  const r2_key = r2KeyFor(campaignId, hash);
  await env.ASSETS.put(r2_key, text, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  const created = await groundingDocs.create(env.DB, {
    campaign_id: campaignId,
    kind,
    source,
    r2_key,
    hash,
  });
  // A concurrent ingest may have won the unique-index race (our INSERT became a
  // no-op), so re-read the canonical row rather than trusting our local object.
  const canonical = await groundingDocs.byHash(env.DB, campaignId, hash);
  return { doc: canonical ?? created, text };
}

/**
 * Load all stored grounding text for a campaign, concatenated with source
 * headers, for stuffing into a prompt. Refuses (throws) if none resolve.
 */
export async function loadGroundingText(
  env: Env,
  campaignId: string,
  options: { docIds?: string[]; query?: string } = {},
): Promise<string> {
  return (await loadGroundingEvidence(env, campaignId, options)).text;
}

export async function loadGroundingEvidence(
  env: Env, campaignId: string, options: { docIds?: string[]; query?: string } = {},
): Promise<GroundingEvidence> {
  const docs = (await groundingDocs.listForCampaign(env.DB, campaignId)).filter((doc) => !options.docIds || options.docIds.includes(doc.id));
  if (docs.length === 0) {
    throw new Error("ground or refuse: no grounding docs for campaign");
  }
  // Read all sources concurrently, keeping each source's kind/URL with its text.
  const loaded = await Promise.all(
    docs.map(async (d) => {
      const obj = await env.ASSETS.get(d.r2_key);
      if (!obj) return null;
      return { kind: d.kind, source: d.source, text: await obj.text() };
    }),
  );
  const parts = loaded.filter((p): p is NonNullable<typeof p> => p !== null);
  if (parts.length === 0) {
    throw new Error("ground or refuse: grounding docs did not resolve in R2");
  }
  // Balance the budget across sources so later sources aren't starved.
  const perSource = Math.floor(60000 / parts.length);
  // Number each source with a stable [S1..Sn] id so the model can attribute
  // facts to a specific source (no markers are printed in the article; the ids
  // just keep sources distinct and reduce cross-source blending/hallucination).
  const sources = parts.map((p, i) => ({ id: `S${i + 1}`, label: `${p.kind === "url" ? "url" : "document"}: ${p.source}`, body: sourceExcerpt(p.text, perSource, options.query || "") }));
  return { text: sourcePrompt(sources), sources };
}

/** Include relevant later paragraphs instead of always discarding a source's tail. */
export function sourceExcerpt(text: string, budget: number, query: string): string {
  if (text.length <= budget) return text;
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])];
  const chunks = text.match(/[\s\S]{1,1000}(?:\s|$)/g) ?? [text];
  const ranked = chunks.map((chunk, index) => ({ chunk, index, score: terms.reduce((sum, term) => sum + (chunk.toLowerCase().includes(term) ? 1 : 0), 0) + (index === 0 ? 1 : 0) }));
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked.slice(0, Math.max(1, Math.floor(budget / 1020))).sort((a, b) => a.index - b.index);
  return selected.map((part) => part.chunk).join("\n[Excerpt gap]\n").slice(0, budget);
}
