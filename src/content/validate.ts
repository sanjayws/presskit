/**
 * Runtime validation/normalization of model output (H-05). The JSON schema only
 * guarantees field types; here we enforce the actual product contract: canonical
 * slug, bounded meta/excerpt/key-phrases, and safe images.
 */
import type { GeneratedArticle } from "../text/article";

export function canonicalizeSlug(slug: string, fallbackTitle: string): string {
  const source = slug && slug.trim() ? slug : fallbackTitle;
  const base = source
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "article").slice(0, 80);
}

/**
 * Clean a single focus keyphrase: no commas, no punctuation or symbols. SEO
 * plugins (Yoast etc.) treat a focus keyphrase as plain words, so keep only
 * letters, numbers, spaces and hyphens; a comma splits phrases, never lives in
 * one. Returns "" if nothing usable remains.
 */
export function sanitizeKeyPhrase(raw: string): string {
  return String(raw)
    .replace(/[^\p{L}\p{N}\s-]/gu, " ") // drop commas and special characters (keep letters incl. accents)
    .replace(/[\s]+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-\s]+|[-\s]+$/g, "")
    .trim();
}

/** Clean, de-duplicate (case-insensitive) and cap a list of key phrases. */
export function sanitizeKeyPhrases(list: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    const cleaned = sanitizeKeyPhrase(String(p));
    const key = cleaned.toLowerCase();
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out.slice(0, 8);
}

/** Plain-text of an HTML fragment (for excerpt fallback). */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a styled article into the persisted contract (title, excerpt,
 * meta, slug, key phrases). Assumes dashes are already stripped. The body is
 * passed through untouched here; the caller sanitizes it separately.
 */
export function normalizeArticle(a: GeneratedArticle): GeneratedArticle {
  const title = a.title.trim().slice(0, 200) || "Untitled";
  const excerpt =
    (a.excerpt && a.excerpt.trim()) || textOf(a.body_html).slice(0, 200);
  const meta_desc =
    (a.meta_desc && a.meta_desc.trim().slice(0, 160)) || excerpt.slice(0, 160);
  const key_phrases = sanitizeKeyPhrases(Array.isArray(a.key_phrases) ? a.key_phrases : []);
  return {
    ...a,
    title,
    slug: canonicalizeSlug(a.slug, title),
    excerpt: excerpt.slice(0, 400),
    meta_desc,
    key_phrases,
  };
}

const IMAGE_MAGIC: { mime: string; sig: number[] }[] = [
  { mime: "image/png", sig: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", sig: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", sig: [0x52, 0x49, 0x46, 0x46] }, // RIFF (WEBP container)
];

const MAX_IMAGE_BYTES = 6_000_000;

/**
 * Verify generated image bytes: bounded size and a recognised PNG/JPEG/WEBP
 * signature. Returns the detected MIME, or null if the image should be rejected.
 */
export function validatedImageMime(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  for (const { mime, sig } of IMAGE_MAGIC) {
    if (sig.every((b, i) => bytes[i] === b)) return mime;
  }
  return null;
}
