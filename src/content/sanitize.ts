/**
 * Allowlist HTML sanitizer for model-generated article bodies, built on the
 * Workers-native HTMLRewriter (a real parser, not regex). Runs before the HTML
 * is persisted, so everything rendered/exported later is already safe. This is
 * the primary defense against stored XSS; the CSP is defense-in-depth.
 */

const ALLOWED_TAGS = new Set([
  "p", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "a",
  "strong", "em", "b", "i", "br", "table", "thead", "tbody", "tr",
  "th", "td", "caption", "code", "pre", "hr", "figure", "img",
]);

// Removed entirely, including their contents.
const DANGEROUS_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "svg", "math",
  "link", "meta", "base", "template", "noscript", "frame", "frameset",
  "applet", "input", "button", "textarea", "select", "option",
]);

// Per-tag allowed attributes. Everything else (class, id, style, on*, etc.) dropped.
const ATTR_ALLOW: Record<string, Set<string>> = {
  img: new Set(["src", "alt", "loading", "width", "height", "decoding"]),
  figure: new Set(["data-presskit-inline"]),
  a: new Set(["href", "title"]),
  th: new Set(["colspan", "rowspan"]),
  td: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
};

function safeHref(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#") || v.startsWith("/")) return true;
  if (/^(https?:|mailto:|tel:)/.test(v)) return true;
  // Relative path without a scheme (no colon before first slash).
  if (!/^[a-z][a-z0-9+.-]*:/.test(v)) return true;
  return false; // javascript:, data:, vbscript:, etc.
}

/** Sanitize an HTML fragment against the allowlist. Async (streams through HTMLRewriter). */
export async function sanitizeHtml(html: string, articleId?: string): Promise<string> {
  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      if (DANGEROUS_TAGS.has(tag)) {
        el.remove();
        return;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        el.removeAndKeepContent(); // unwrap unknown tags, keep their text
        return;
      }
      if (tag === "img" && (!articleId || ![1, 2, 3].some((slot) => ["png", "svg"].some((kind) => el.getAttribute("src") === `/articles/${articleId}/inline-images/${slot}.${kind}`)))) { el.remove(); return; }
      if (tag === "figure" && !/^[1-3]$/.test(el.getAttribute("data-presskit-inline") || "")) el.removeAttribute("data-presskit-inline");
      const allow = ATTR_ALLOW[tag] ?? EMPTY;
      const names = Array.from(el.attributes, (a) => a[0] ?? "");
      for (const name of names) {
        if (!name) continue;
        const n = name.toLowerCase();
        if (!allow.has(n)) {
          el.removeAttribute(name);
          continue;
        }
        if (tag === "img" && (n === "width" || n === "height")) {
          const value = el.getAttribute(name) || "";
          if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 8192) el.removeAttribute(name);
        }
        if (tag === "img" && n === "decoding" && !["async", "sync", "auto"].includes(el.getAttribute(name) || "")) el.removeAttribute(name);
        if (tag === "a" && n === "href" && !safeHref(el.getAttribute(name) ?? "")) {
          el.removeAttribute(name);
        }
      }
      if (tag === "a") el.setAttribute("rel", "nofollow noopener noreferrer");
    },
  });
  const res = rewriter.transform(new Response(html));
  return await res.text();
}

const EMPTY = new Set<string>();
