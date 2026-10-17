/**
 * Deterministic house-style linter. The em-dash / en-dash rule lives here, in
 * code, never in a prompt. Strips every em-dash and en-dash used as punctuation,
 * validates word count, and drives a single regeneration on failure.
 */
import { countWords, trimToWordCap } from "./engine";
import type { GeneratedArticle } from "../text/article";

// em-dash, en-dash, horizontal bar, figure dash, minus sign used as dash.
const DASH_CHARS = "—–―‒−";
const DASH_CLASS = `[${DASH_CHARS}]`;
const ANY_DASH = new RegExp(DASH_CLASS, "g");
// Non-global copy for `.test()`: a global regex carries `lastIndex` state across
// calls, which makes consecutive hasDash() calls on the same string flip-flop.
const ANY_DASH_TEST = new RegExp(DASH_CLASS);

/**
 * Replace em/en dashes used as punctuation. Numeric ranges (2020–2024) become a
 * plain hyphen. A spaced or word-joining dash becomes a comma, or a period when
 * it clearly joins two sentences. Result contains zero em/en dash characters.
 */
export function stripDashes(input: string): string {
  let s = input;

  // 1. Numeric range: 12–15, 2020 — 2024  ->  12-15
  s = s.replace(new RegExp(`(\\d)\\s*${DASH_CLASS}\\s*(\\d)`, "g"), "$1-$2");

  // 2. Sentence-joining dash: lowercase/./ before, space, uppercase after -> ". "
  s = s.replace(
    new RegExp(`([a-z0-9,;:])\\s*${DASH_CLASS}\\s+([A-Z])`, "g"),
    "$1. $2",
  );

  // 3. General punctuation dash (spaced or word-joining) -> ", "
  s = s.replace(new RegExp(`\\s*${DASH_CLASS}\\s*`, "g"), ", ");

  // 4. Anything left (edge cases) -> remove.
  s = s.replace(ANY_DASH, "");

  // Tidy double punctuation the replacements may create.
  s = s.replace(/,\s*,/g, ",").replace(/\.\s*,/g, ".").replace(/,\s*\./g, ".");
  return s;
}

export function hasDash(input: string): boolean {
  return ANY_DASH_TEST.test(input);
}

// Grounding sources are numbered [S1], [S2], ... in the prompt purely so the
// model can attribute facts to a specific source. It is told not to print them,
// but as a deterministic safety net we strip any that leak (single or grouped,
// e.g. "[S2]", "[S1, S3]") so they never reach the published article.
const SOURCE_MARKER = /\s*\[\s*[Ss]\d+(?:\s*,\s*[Ss]?\d+)*\s*\]/g;
export function stripSourceMarkers(input: string): string {
  return input.replace(SOURCE_MARKER, "").replace(/\s+([.,;:!?])/g, "$1");
}

export interface StyleResult {
  article: GeneratedArticle;
  ok: boolean;
  wordCount: number;
  dashesFound: boolean;
}

/**
 * Apply the full deterministic style pass to a generated article.
 * Strips dashes on every text field, trims the body to the word cap, and caps
 * meta_desc to 160 chars. Reports whether the result is clean.
 */
export function applyStyle(
  article: GeneratedArticle,
  maxWords: number,
): StyleResult {
  const cleaned: GeneratedArticle = {
    ...article,
    title: stripDashes(stripSourceMarkers(article.title)),
    excerpt: stripDashes(stripSourceMarkers(article.excerpt)),
    meta_desc: stripDashes(stripSourceMarkers(article.meta_desc)).slice(0, 160).trim(),
    body_html: trimToWordCap(stripDashes(stripSourceMarkers(article.body_html)), maxWords),
    // Strip markers from the slug source too, BEFORE canonicalisation turns a
    // stray "[S1]" into a stranded "s1" token.
    slug: stripSourceMarkers(article.slug),
    key_phrases: article.key_phrases.map((k) => stripDashes(stripSourceMarkers(k))),
  };

  const combinedText = [
    cleaned.title,
    cleaned.excerpt,
    cleaned.meta_desc,
    cleaned.body_html,
    ...cleaned.key_phrases,
  ].join(" ");

  const wordCount = countWords(cleaned.body_html);
  const dashesFound = hasDash(combinedText);
  const ok = !dashesFound && wordCount <= maxWords;

  return { article: cleaned, ok, wordCount, dashesFound };
}

/**
 * Does the RAW model output violate house style (em/en dashes present, or over
 * the word cap)? This is the trigger for a single regeneration — measured on the
 * model's output, before the deterministic pass rewrites it.
 */
export function violatesStyle(
  article: GeneratedArticle,
  maxWords: number,
): boolean {
  const text = [
    article.title,
    article.excerpt,
    article.meta_desc,
    article.body_html,
    ...article.key_phrases,
  ].join(" ");
  return hasDash(text) || countWords(article.body_html) > maxWords;
}

/**
 * Run the style pass with a single regeneration on failure. If the model's raw
 * output violates house style we regenerate exactly once, then apply the
 * deterministic pass to whichever output we keep. applyStyle guarantees zero
 * dashes and the word cap either way, so the run always proceeds afterward.
 */
export async function styleWithRegenerate(
  article: GeneratedArticle,
  maxWords: number,
  regenerate: () => Promise<GeneratedArticle>,
): Promise<GeneratedArticle> {
  const chosen = violatesStyle(article, maxWords)
    ? await regenerate() // one retry, then proceed regardless
    : article;
  return applyStyle(chosen, maxWords).article;
}
