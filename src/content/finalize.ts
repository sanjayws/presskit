import type { GeneratedArticle } from "../text/article";
import { applyStyle, stripDashes } from "../style/lint";
import { normalizeArticle, sanitizeKeyPhrases } from "./validate";
import { sanitizeHtml } from "./sanitize";
import { enrichArticleBody, type CtaConfig, type ReferenceLink } from "./enrich";
import { isCampaignChannel, type OutputFormat } from "../style/engine";

export function appendSignature(bodyHtml: string, signature: string): string {
  const sig = stripDashes(signature).trim();
  if (!sig) return bodyHtml;
  const text = sig.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `${bodyHtml}\n<p class="article-signature"><em>${text}</em></p>`;
}

/** Review the exact publishable candidate. Never chop sections to meet a word cap. */
export async function prepareArticle(core: GeneratedArticle, options: {
  referenceLinks: ReferenceLink[]; cta: CtaConfig | null; signature: string; input: { primaryKw: string; outputFormat?: OutputFormat };
}): Promise<GeneratedArticle> {
  const normalized = normalizeArticle(applyStyle(core, Number.MAX_SAFE_INTEGER).article);
  const safeCore = await sanitizeHtml(normalized.body_html);
  const enriched = await sanitizeHtml(enrichArticleBody(safeCore, options.referenceLinks, options.cta, isCampaignChannel(options.input.outputFormat)));
  return { ...normalized, body_html: appendSignature(enriched, options.signature),
    key_phrases: sanitizeKeyPhrases([options.input.primaryKw, ...normalized.key_phrases]) };
}
