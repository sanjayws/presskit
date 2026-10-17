/**
 * Deterministic body enrichment (house style in code, not a prompt):
 *  - reference links the user supplied are woven into the article as real <a>
 *    anchors — inline where their label text appears, otherwise as a
 *    "Further reading" list, so every link is guaranteed to appear;
 *  - the chosen call-to-action preset is inserted as a distinct blockquote at a
 *    sensible spot (just before the concluding section).
 *
 * Runs BEFORE the HTML sanitizer, so every injected href is still re-validated
 * (safeHref) and any unsafe URL is dropped downstream.
 */
import { countWords, type CtaOption } from "../style/engine";

export interface ReferenceLink {
  url: string;
  label: string;
}

const MAX_REFERENCE_LINKS = 10;
const MAX_REF_TEXT_BYTES = 16_000; // whole textarea / stored JSON
const MAX_URL_LEN = 2048;
const MAX_LABEL_LEN = 160;

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse the form's textarea (one link per line, "URL" or "URL | anchor text"). */
export function parseReferenceLinksText(raw: string): ReferenceLink[] {
  return raw
    .slice(0, MAX_REF_TEXT_BYTES) // bound the whole field before parsing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.indexOf("|");
      const url = (bar === -1 ? line : line.slice(0, bar)).trim().slice(0, MAX_URL_LEN);
      const label = (bar === -1 ? "" : line.slice(bar + 1).trim()).slice(0, MAX_LABEL_LEN);
      return { url, label };
    })
    .filter((r) => isHttpUrl(r.url))
    .slice(0, MAX_REFERENCE_LINKS);
}

/** Read/validate the stored JSON array back into reference links. */
export function readReferenceLinks(json: string): ReferenceLink[] {
  try {
    const arr = JSON.parse(json.slice(0, MAX_REF_TEXT_BYTES)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        return {
          url: (typeof o.url === "string" ? o.url : "").slice(0, MAX_URL_LEN),
          label: (typeof o.label === "string" ? o.label : "").slice(0, MAX_LABEL_LEN),
        };
      })
      .filter((r) => isHttpUrl(r.url))
      .slice(0, MAX_REFERENCE_LINKS);
  } catch {
    return [];
  }
}

/**
 * Wrap the first plain-text occurrence of `phrase` in an <a href>, skipping text
 * that is inside an existing anchor or a heading. Returns the (possibly)
 * modified HTML and whether a replacement happened.
 */
// Contexts where an inline auto-link is wrong or unsafe: existing links,
// headings, code/preformatted text, and any dangerous container the sanitizer
// would later strip (which would otherwise silently swallow the link).
const NO_LINK_TAGS = new Set([
  "a", "h1", "h2", "h3", "h4", "h5", "h6", "code", "pre",
  "script", "style", "svg", "math", "form", "template", "noscript", "iframe",
]);

function linkFirstMention(html: string, phrase: string, url: string): { html: string; used: boolean } {
  if (!phrase) return { html, used: false };
  const tokens = html.split(/(<[^>]+>)/);
  const phraseRe = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
  let skipDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("<")) {
      const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(tok);
      if (m) {
        const closing = m[1] === "/";
        const name = (m[2] ?? "").toLowerCase();
        const selfClosing = tok.endsWith("/>");
        if (NO_LINK_TAGS.has(name) && !selfClosing)
          skipDepth = Math.max(0, skipDepth + (closing ? -1 : 1));
      }
      continue;
    }
    if (skipDepth > 0) continue;
    const match = phraseRe.exec(tok);
    if (match) {
      const anchor = `<a href="${escapeAttr(url)}">${escapeText(match[0])}</a>`;
      tokens[i] = tok.slice(0, match.index) + anchor + tok.slice(match.index + match[0].length);
      return { html: tokens.join(""), used: true };
    }
  }
  return { html, used: false };
}

/** Build the CTA blockquote; links the action to `ctaUrl` when one is available. */
function ctaBlock(cta: CtaOption, ctaUrl: string | null): string {
  const action =
    ctaUrl && cta.action
      ? ` <a href="${escapeAttr(ctaUrl)}">${escapeText(cta.action)}</a>.`
      : "";
  return `<blockquote><p><strong>${escapeText(cta.heading)}</strong> ${escapeText(cta.body)}${action}</p></blockquote>`;
}

/** Insert a block just before the last <h2> (the concluding section), else append. */
function insertBeforeLastSection(bodyHtml: string, block: string): string {
  const idx = bodyHtml.toLowerCase().lastIndexOf("<h2");
  if (idx <= 0) return `${bodyHtml}\n${block}`;
  return `${bodyHtml.slice(0, idx)}${block}\n${bodyHtml.slice(idx)}`;
}

export interface CtaConfig {
  preset: CtaOption;
  /** Resolved href from the CTA action + target; null for a text-only CTA. */
  href: string | null;
}

/**
 * Weave reference links and (optionally) a CTA into the article body. Pure and
 * deterministic: same inputs always produce the same output (safe for retries).
 */
export function enrichArticleBody(
  bodyHtml: string,
  links: ReferenceLink[],
  cta: CtaConfig | null,
  compact = false,
): string {
  let html = bodyHtml;
  const leftovers: ReferenceLink[] = [];

  // 1. Inline-anchor links whose label appears in the text; collect the rest.
  for (const link of links) {
    if (link.label) {
      const res = linkFirstMention(html, link.label, link.url);
      html = res.html;
      if (!res.used) leftovers.push(link);
    } else {
      leftovers.push(link);
    }
  }

  // 2. CTA block (links to its own configured action target, not a ref link).
  if (cta) {
    html = compact
      ? `${html}\n<p>${cta.href ? `<a href="${escapeAttr(cta.href)}">${escapeText(cta.preset.action)}</a>` : escapeText(cta.preset.action)}</p>`
      : insertBeforeLastSection(html, ctaBlock(cta.preset, cta.href));
  }

  // 3. Guarantee every link appears: any not placed inline go to Further reading.
  if (leftovers.length && !compact) {
    const items = leftovers
      .map((l) => {
        const text = l.label || l.url;
        return `<li><a href="${escapeAttr(l.url)}">${escapeText(text)}</a></li>`;
      })
      .join("");
    html = `${html}\n<h3>Further reading</h3>\n<ul>${items}</ul>`;
  }

  return html;
}

/**
 * Upper bound on the words enrichment will ADD to the body (so the caller can
 * reserve room and keep the final article within the hard word cap). Inline
 * anchors add no words (they wrap existing text); only the CTA block and a
 * worst-case "Further reading" list (every link falling through) add words.
 */
export function enrichmentReserveWords(links: ReferenceLink[], cta: CtaConfig | null, compact = false): number {
  if (compact) return (cta ? countWords(cta.preset.action) + 1 : 0) + links.length;
  let n = 0;
  if (cta) n += countWords(ctaBlock(cta.preset, cta.href));
  if (links.length) {
    n += 2; // "Further reading" heading
    for (const l of links) n += countWords(l.label || l.url);
  }
  return n;
}
