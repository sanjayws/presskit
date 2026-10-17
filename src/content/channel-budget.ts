import { channelProfile, countWords, ctaByValue, buildCtaHref, isCampaignChannel, OUTPUT_FORMATS } from "../style/engine";
import { enrichmentReserveWords, readReferenceLinks } from "./enrich";
/** Reject impossible fixed-text budgets before research/writing calls. */
export function channelBudgetError(fields: { max_words: number; reference_links: string; signature: string; cta: string; cta_action: string; cta_target: string }, formats: string[]): string | null {
  const links = readReferenceLinks(fields.reference_links);
  const preset = ctaByValue(fields.cta);
  const cta = preset ? { preset, href: buildCtaHref(fields.cta_action, fields.cta_target) } : null;
  for (const format of formats) {
    const limit = Math.min(fields.max_words, channelProfile(format).maxWords);
    const reserve = enrichmentReserveWords(links, cta, isCampaignChannel(format)) + countWords(fields.signature);
    if (limit - reserve < (format === "chat" ? 30 : 80)) return `${OUTPUT_FORMATS.find((f) => f.value === format)?.label || format}: links, call to action and signature leave too little room within ${limit} words. Shorten them or increase the word limit within the channel maximum.`;
  }
  return null;
}
