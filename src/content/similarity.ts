/**
 * Deterministic near-duplicate detection (no vector DB, per the project rule).
 * We compare a new article to the user's prior articles using two cheap set
 * measures: Jaccard over significant title words and Jaccard over 3-word body
 * shingles. The blended score flags (never blocks) likely repeats.
 */

// Very small stopword list: enough to stop trivial glue words from inflating
// the overlap, without needing a linguistics package.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "this",
  "that", "from", "have", "has", "was", "were", "will", "can", "our", "their",
  "them", "they", "its", "it's", "into", "than", "then", "when", "what", "why",
  "how", "who", "which", "a", "an", "of", "to", "in", "on", "at", "is", "be",
  "as", "by", "or", "if", "we", "us", "so", "no",
]);

const SHINGLE_K = 3;
const MAX_BODY_WORDS = 1500; // bound work for very long articles

export interface ArticleSignature {
  titleTokens: Set<string>;
  shingles: Set<string>;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, " ") // strip any HTML
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function significant(tokens: string[]): string[] {
  return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** k-word shingles over the (significant) body words. */
function shingleSet(bodyWords: string[], k = SHINGLE_K): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= bodyWords.length; i++) {
    out.add(bodyWords.slice(i, i + k).join(" "));
  }
  return out;
}

export function articleSignature(title: string, bodyHtml: string): ArticleSignature {
  const titleTokens = new Set(significant(words(title)));
  const bodyWords = significant(words(bodyHtml)).slice(0, MAX_BODY_WORDS);
  return { titleTokens, shingles: shingleSet(bodyWords) };
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Blended 0..1 similarity: body shingles dominate, title breaks ties. */
export function similarity(a: ArticleSignature, b: ArticleSignature): number {
  const body = jaccard(a.shingles, b.shingles);
  const title = jaccard(a.titleTokens, b.titleTokens);
  return Number((0.65 * body + 0.35 * title).toFixed(4));
}

export interface PriorArticle {
  title: string;
  signature: ArticleSignature;
}

/** The most similar prior article to `target`, or null if none exist. */
export function mostSimilar(
  target: ArticleSignature,
  priors: PriorArticle[],
): { title: string; score: number } | null {
  let best: { title: string; score: number } | null = null;
  for (const p of priors) {
    const score = similarity(target, p.signature);
    if (!best || score > best.score) best = { title: p.title, score };
  }
  return best;
}

/** At/above this blended score, an article is flagged as a likely repeat. */
export const SIMILAR_THRESHOLD = 0.5;
