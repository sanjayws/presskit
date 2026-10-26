/**
 * Deterministic output-format renderer. The pipeline keeps ONE canonical body:
 * sanitized, house-styled HTML. This module serialises that HTML into the target
 * platform the owner picked at the gate, in code (never a second model call), so
 * the format is exact and safe:
 *
 *   html     -> the HTML as-is (WordPress / rich editors)
 *   word     -> the HTML wrapped as a Word-openable .doc document
 *   markdown -> Markdown (headings, bold, lists, tables, links)
 *   plain    -> plain text (no markup; tables become readable lines)
 *   social   -> plain text with no tables/headings + trailing hashtags (FB/LinkedIn)
 *
 * The input is always our own sanitized allowlist HTML (p, h2-h4, ul/ol/li,
 * blockquote, a, strong/em/b/i, br, table/thead/tbody/tr/th/td), so a small
 * bounded parser is enough. No em/en dashes are ever emitted (house rule).
 */
import { SOCIAL_MAX_WORDS, type OutputFormat } from "../style/engine";

type ElNode = { type: "el"; tag: string; attrs: Record<string, string>; children: Node[] };
type TextNode = { type: "text"; text: string };
type Node = ElNode | TextNode;

const VOID_TAGS = new Set(["br", "img"]);

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)));
}
function cp(n: number): string {
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-z][a-z0-9-]*)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]!.toLowerCase()] = decodeEntities(m[2]!);
  return attrs;
}

/** Parse our sanitized HTML into a shallow node tree. */
function parseHtml(html: string): Node[] {
  const root: ElNode = { type: "el", tag: "root", attrs: {}, children: [] };
  const stack: ElNode[] = [root];
  const re = /<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (raw: string) => {
    if (!raw) return;
    stack[stack.length - 1]!.children.push({ type: "text", text: decodeEntities(raw) });
  };
  while ((m = re.exec(html))) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    const tagStr = m[0];
    if (tagStr.startsWith("<!--")) continue;
    const name = tagStr.match(/^<\s*\/?\s*([a-z0-9]+)/i);
    if (!name) continue;
    const tag = name[1]!.toLowerCase();
    if (/^<\s*\//.test(tagStr)) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElNode = { type: "el", tag, attrs: parseAttrs(tagStr), children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!(/\/\s*>$/.test(tagStr) || VOID_TAGS.has(tag))) stack.push(node);
  }
  pushText(html.slice(last));
  return root.children;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ");
}
function tidyBlocks(blocks: string[]): string {
  return blocks
    .map((b) => b.replace(/[ \t]+$/gm, "").trim())
    .filter((b) => b.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Markdown ---------------------------------------------------------------

// Escape the inline Markdown metacharacters that could change meaning if they
// appear literally in grounded/model text. `.` and `-` are NOT escaped here (they
// are everywhere in prose); leading list/heading markers are handled per-block.
// `|` is intentionally excluded: it only has meaning inside tables, where cells
// do their own pipe-escaping. Escaping it here would double-escape table cells.
function escMdText(s: string): string {
  return s.replace(/([\\`*_{}\[\]<>~])/g, "\\$1");
}

// A leading block marker (#, >, -, +, *, or "1.") turns a paragraph into a
// heading/list/quote. Escape it so the paragraph stays a paragraph.
function escMdLeading(block: string): string {
  return block
    .replace(/^(\s*)(#{1,6}\s|>\s|[-+*]\s)/, (_m, ws, mark) => `${ws}\\${mark}`)
    .replace(/^(\s*)(\d+)([.)])(\s)/, (_m, ws, d, p, sp) => `${ws}${d}\\${p}${sp}`);
}

// A Markdown link destination cannot contain unescaped spaces or parentheses;
// wrap those in angle brackets, which Markdown allows.
function mdDestination(href: string): string {
  return /[\s()]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
}

function mdInline(nodes: Node[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return escMdText(collapseWs(n.text));
      switch (n.tag) {
        case "img":
          return n.attrs.src ? `![${escMdText(n.attrs.alt || "Illustration")}](${mdDestination(n.attrs.src)})` : "";
        case "br":
          return "  \n";
        case "strong":
        case "b":
          return `**${mdInline(n.children).trim()}**`;
        case "em":
        case "i":
          return `*${mdInline(n.children).trim()}*`;
        case "a": {
          const inner = mdInline(n.children).trim() || (n.attrs.href ? escMdText(n.attrs.href) : "");
          return n.attrs.href ? `[${inner}](${mdDestination(n.attrs.href)})` : inner;
        }
        default:
          return mdInline(n.children);
      }
    })
    .join("");
}

function mdList(list: ElNode, ordered: boolean): string {
  const items = list.children.filter((c): c is ElNode => c.type === "el" && c.tag === "li");
  return items
    .map((li, i) => {
      const nested = li.children.filter(
        (c): c is ElNode => c.type === "el" && (c.tag === "ul" || c.tag === "ol"),
      );
      const inline = li.children.filter((c) => !(c.type === "el" && (c.tag === "ul" || c.tag === "ol")));
      let out = `${ordered ? `${i + 1}. ` : "- "}${mdInline(inline).trim()}`;
      for (const sub of nested) {
        out +=
          "\n" +
          mdList(sub, sub.tag === "ol")
            .split("\n")
            .map((l) => "  " + l)
            .join("\n");
      }
      return out;
    })
    .join("\n");
}

function rowsOf(table: ElNode): string[][] {
  const rows: string[][] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type !== "el") continue;
      if (n.tag === "tr") {
        rows.push(
          n.children
            .filter((c): c is ElNode => c.type === "el" && (c.tag === "td" || c.tag === "th"))
            .map((c) => mdInline(c.children).trim()),
        );
      } else walk(n.children);
    }
  };
  walk(table.children);
  return rows.filter((r) => r.length > 0);
}

function mdTable(table: ElNode): string {
  const rows = rowsOf(table);
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|"));
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const sep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  return [line(rows[0]!), sep, ...rows.slice(1).map(line)].join("\n");
}

function mdBlocks(nodes: Node[]): string {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      const t = escMdText(collapseWs(n.text)).trim();
      if (t) out.push(escMdLeading(t));
      continue;
    }
    switch (n.tag) {
      case "h2":
        out.push(`## ${mdInline(n.children).trim()}`);
        break;
      case "h3":
        out.push(`### ${mdInline(n.children).trim()}`);
        break;
      case "h4":
        out.push(`#### ${mdInline(n.children).trim()}`);
        break;
      case "ul":
        out.push(mdList(n, false));
        break;
      case "ol":
        out.push(mdList(n, true));
        break;
      case "blockquote":
        out.push(
          mdBlocks(n.children)
            .split("\n")
            .map((l) => `> ${l}`.replace(/\s+$/, ""))
            .join("\n"),
        );
        break;
      case "table":
        out.push(mdTable(n));
        break;
      case "img":
        out.push(mdInline([n]));
        break;
      case "p":
        out.push(escMdLeading(mdInline(n.children).trim()));
        break;
      default:
        out.push(mdBlocks(n.children));
    }
  }
  return tidyBlocks(out);
}

export function toMarkdown(html: string): string {
  return mdBlocks(parseHtml(html));
}

// ---- Plain text -------------------------------------------------------------

function plainInline(nodes: Node[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return collapseWs(n.text);
      switch (n.tag) {
        case "br":
          return "\n";
        case "a": {
          const inner = plainInline(n.children).trim();
          const href = n.attrs.href || "";
          if (!href) return inner;
          if (!inner || inner === href) return href;
          return `${inner} (${href})`;
        }
        default:
          return plainInline(n.children);
      }
    })
    .join("");
}

function plainBlocks(nodes: Node[]): string {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      const t = collapseWs(n.text).trim();
      if (t) out.push(t);
      continue;
    }
    switch (n.tag) {
      case "h2":
      case "h3":
      case "h4":
      case "p":
        out.push(plainInline(n.children).trim());
        break;
      case "ul":
        out.push(
          n.children
            .filter((c): c is ElNode => c.type === "el" && c.tag === "li")
            .map((li) => `- ${plainInline(li.children).trim()}`)
            .join("\n"),
        );
        break;
      case "ol":
        out.push(
          n.children
            .filter((c): c is ElNode => c.type === "el" && c.tag === "li")
            .map((li, i) => `${i + 1}. ${plainInline(li.children).trim()}`)
            .join("\n"),
        );
        break;
      case "blockquote":
        out.push(plainBlocks(n.children));
        break;
      case "table":
        out.push(rowsOf(n).map((r) => r.join("  |  ")).join("\n"));
        break;
      default:
        out.push(plainBlocks(n.children));
    }
  }
  return tidyBlocks(out);
}

export function toPlain(html: string): string {
  return plainBlocks(parseHtml(html));
}

/** Basic messaging markup; links stay visible and HTML never reaches chat. */
export function toChat(html: string): string {
  const mark = (nodes: Node[]): Node[] => nodes.map((node) => {
    if (node.type === "text") return node;
    const children = mark(node.children);
    const marker = node.tag === "strong" || node.tag === "b" ? "*" : node.tag === "em" || node.tag === "i" ? "_" : "";
    return { ...node, children: marker ? [{ type: "text", text: marker }, ...children, { type: "text", text: marker }] : children };
  });
  return plainBlocks(mark(parseHtml(html)));
}

/** Standalone, single-column email. Images are uploaded in the sender's editor. */
export function toEmail(html: string, subject: string, preheader = ""): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = html.replace(/<(p|h2|h3|ul|ol|blockquote|figure)(\s[^>]*)?>/g, (_tag, tag: string) => `<${tag} style="margin:0 0 16px;line-height:1.6;${tag.startsWith("h") ? "font-size:20px;" : ""}">`)
    .replace(/<img\b/g, '<img style="display:block;max-width:100%;height:auto"');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head><body style="margin:0;background:#ffffff;color:#172b36;font-family:Arial,sans-serif;font-size:16px"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(preheader)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td style="padding:24px">${body}</td></tr></table></td></tr></table></body></html>`;
}

// ---- Social + Word ----------------------------------------------------------

function hashtag(phrase: string): string {
  const parts = phrase.split(/[^a-z0-9]+/i).filter(Boolean);
  if (parts.length === 0) return "";
  return "#" + parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}
function capWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : words.slice(0, Math.max(0, max)).join(" ");
}

/**
 * Serialize a social post and enforce a HARD word cap over the WHOLE output,
 * hashtags included (M-03). The hashtag line is preserved; the body is trimmed to
 * fit under `maxWords - hashtagWords`, so enrichment (CTA, links, signature) can
 * never push the final post past the cap.
 */
export function toSocial(html: string, keyPhrases: string[], maxWords = SOCIAL_MAX_WORDS): string {
  const text = toPlain(html);
  // Only synthesize hashtags if the writer produced none anywhere in the post.
  const appended = /(^|\s)#[A-Za-z0-9]/.test(text)
    ? ""
    : keyPhrases.slice(0, 4).map(hashtag).filter(Boolean).join(" ");
  // Hard cap over the WHOLE post, hashtags included: trim the body, reserving
  // room for the appended hashtag line so the final output never exceeds maxWords.
  const body = capWords(text, Math.max(1, maxWords - countWords(appended)));
  return (appended ? `${body}\n\n${appended}` : body).trim();
}

/** HTML that Microsoft Word opens natively (headings and tables preserved). */
export function toWordDoc(html: string, title: string): string {
  const t = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${t}</title></head><body>${html}</body></html>`;
}

export interface RenderedOutput {
  body: string;
  ext: string;
  mime: string;
}

/**
 * Render the canonical HTML body into the chosen output format. `keyPhrases` and
 * `title` are only used by social (hashtags) and word (document title).
 */
export function renderOutput(
  html: string,
  format: OutputFormat,
  opts: { keyPhrases: string[]; title: string; excerpt?: string; maxWords?: number },
): RenderedOutput {
  switch (format) {
    case "email":
      return { body: toEmail(html, opts.title, opts.excerpt), ext: "html", mime: "text/html; charset=utf-8" };
    case "chat":
      return { body: toChat(html), ext: "txt", mime: "text/plain; charset=utf-8" };
    case "linkedin":
      return { body: toPlain(html), ext: "txt", mime: "text/plain; charset=utf-8" };
    case "markdown":
      return { body: toMarkdown(html), ext: "md", mime: "text/markdown; charset=utf-8" };
    case "plain":
      return { body: toPlain(html), ext: "txt", mime: "text/plain; charset=utf-8" };
    case "social":
      return {
        body: toSocial(html, opts.keyPhrases, opts.maxWords ?? SOCIAL_MAX_WORDS),
        ext: "txt",
        mime: "text/plain; charset=utf-8",
      };
    case "word":
      return { body: toWordDoc(html, opts.title), ext: "doc", mime: "application/msword" };
    case "html":
    default:
      return { body: html, ext: "html", mime: "text/html; charset=utf-8" };
  }
}

/**
 * Whether this format is shown/edited as rich HTML on the result screen (true)
 * or as a read-only copyable text block (false). Word edits its HTML like HTML.
 */
export function isRichFormat(format: OutputFormat): boolean {
  return format === "html" || format === "word" || format === "email" || format === "linkedin";
}
