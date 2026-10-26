/** Deterministic draft suggestions, never a generation gate or ranking score. */
import type { Article } from "../db/repos";
import { toPlain } from "../content/render";
import { countWords } from "../style/engine";
import { SEO_SKILLS_VERSION, usesArticleSeo, type SeoContext } from "./skills";
export interface SeoCheck { id: string; state: "ready" | "consider"; label: string; advice: string }
export interface SeoDraftReview { version: string; applicable: boolean; checks: SeoCheck[]; publishing: string[] }
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase();
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((v) => v !== undefined) || "";
export function seoDraftReview(article: Article, context: SeoContext = {}): SeoDraftReview {
  const applicable = usesArticleSeo({ ...context, outputFormat: context.outputFormat || article.output_format as SeoContext["outputFormat"] });
  if (!applicable) return { version: SEO_SKILLS_VERSION, applicable: false, checks: [], publishing: [] };
  const checks: SeoCheck[] = [];
  const add = (id: string, ready: boolean, label: string, advice: string) => checks.push({ id, state: ready ? "ready" : "consider", label, advice });
  const title = article.title.trim(), description = article.meta_desc.trim();
  add("title", !!title && title.length <= 70, "Headline clarity", title && title.length <= 70 ? "A concise headline is ready for a final relevance check." : "Consider a concise, descriptive headline that accurately previews the article. Character counts are drafting guidance, not a ranking rule.");
  const repeats = !!title && norm(description).startsWith(norm(title));
  add("description", !!description && !repeats && description.length <= 160, "Distinct search description", description && !repeats && description.length <= 160 ? "The description adds a separate summary beyond the headline." : "Write a distinct, useful summary of this article instead of repeating the headline. Keep it concise; search snippets can vary.");
  add("slug", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug), "Readable slug", "Use a short, descriptive slug; the publishing site supplies the final URL.");
  let phrases: string[] = [];
  try { const value: unknown = JSON.parse(article.key_phrases); if (Array.isArray(value)) phrases = value.filter((p): p is string => typeof p === "string"); } catch { /* optional metadata */ }
  const opening = toPlain(article.body_html).split(/\s+/).slice(0, 100).join(" ");
  const focus = phrases[0]?.trim();
  add("topic", !!focus && [title, description, opening].some((v) => norm(v).includes(norm(focus))), "Natural topic context", "Make the topic clear in the title, description or opening where it fits. Variations are fine; there is no target keyword density and narrative openings can stay intact.");
  const headings = [...article.body_html.matchAll(/<h([2-4])\b/gi)].map((h) => Number(h[1]));
  const hierarchy = headings.every((level, i) => level <= (headings[i - 1] || 1) + 1);
  add("headings", hierarchy && (headings.length > 0 || countWords(article.body_html) < 500), "Useful heading structure", "Use descriptive H2/H3 headings when the brief and length call for them. The publishing page normally provides the single H1 title; avoid adding a second one in the body.");
  const images = [...article.body_html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  add("image-alt", images.every((image) => !!toPlain(`<p>${attr(image, "alt")}</p>`).trim()), "Image descriptions", "Describe each image's actual subject in alt text. Use empty alt text only for purely decorative images, and avoid keyword lists.");
  add("image-size", images.every((image) => Number(attr(image, "width")) > 0 && Number(attr(image, "height")) > 0), "Reserved image space", "Set the correct intrinsic width and height for inline images at publication, and optimise files for the site. This is a draft check, not a live performance measurement.");
  return { version: SEO_SKILLS_VERSION, applicable: true, checks, publishing: [
    "Review factual claims and any accepted editorial exceptions against the originals; an SEO checklist does not verify evidence or predict rankings.",
    "Set the real author/byline, publisher, canonical page URL and accurate publication/update dates in your CMS; never invent expertise or dates.",
    "Upload images to public media URLs, review descriptive alt text and compress them for the destination. Preview the final page on mobile.",
    "Check crawl/index settings, internal links, page speed and structured data on the published site. These cannot be established from an unpublished draft.",
  ] };
}
/** Only visible saved facts; publication identities/URLs/dates remain with the CMS. */
export function articleSchemaStarter(article: Article, context: SeoContext = {}): Record<string, unknown> | null {
  if ((context.outputFormat || article.output_format) !== "html" || !usesArticleSeo(context)) return null;
  return { "@context": "https://schema.org", "@type": "Article", headline: article.title, description: article.meta_desc, wordCount: countWords(article.body_html) };
}
