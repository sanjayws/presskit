/** A separate editor assesses the complete candidate; revisions never self-approve. */
import type { Env } from "../env";
import type { ArticleInput, GeneratedArticle } from "../text/article";
import { ARTICLE_SCHEMA, editorialBlock, gearsBlock, HTML_RULES, validateGeneratedArticle } from "../text/article";
import { QUALITY_RULES } from "../text/instructions";
import { generate } from "../anthropic/client";
import { recordOf } from "../providers/http";
import { RetryableError } from "../errors";
import { countWords, channelProfile, isOutputFormat } from "../style/engine";
import { toPlain, renderOutput } from "../content/render";
import type { CtaConfig, ReferenceLink } from "../content/enrich";
import { visibleMarkdown } from "../grounding/evidence";

export const MAX_REVISIONS = 3;
const CHECKS = ["factual_accuracy", "brief_coverage", "section_order", "specificity", "readability"] as const;
export interface EditorialReport {
  passed: boolean;
  checks: Record<typeof CHECKS[number], boolean>;
  requirements: { brief_quote: string; article_quote: string; covered: boolean }[];
  facts: { claim: string; source_id: string; source_quote: string }[];
  issues: string[];
}
export interface EditorialCheckpoint {
  version: 1;
  state: "review" | "revise" | "passed" | "needs_attention" | "accepted";
  acceptance?: { userId: string; at: string; fingerprint: string };
  revision: number;
  model: string;
  input: ArticleInput;
  core: GeneratedArticle;
  finalMaxWords: number;
  referenceLinks: ReferenceLink[];
  cta: CtaConfig | null;
  signature: string;
  report: EditorialReport | null;
}
export const editorialKey = (articleId: string) => `articles/${articleId}/editorial.json`;
export async function loadEditorial(env: Env, articleId: string): Promise<EditorialCheckpoint | null> {
  const object = await env.ASSETS.get(editorialKey(articleId));
  if (!object) return null;
  if (object.size > 500000) throw new Error("Editorial checkpoint exceeds the size limit");
  const checkpoint = await object.json<EditorialCheckpoint>();
  if (checkpoint.version !== 1 || !checkpoint.input || !checkpoint.core) throw new Error("Invalid editorial checkpoint");
  return checkpoint;
}
export async function saveEditorial(env: Env, articleId: string, checkpoint: EditorialCheckpoint): Promise<void> {
  await env.ASSETS.put(editorialKey(articleId), JSON.stringify(checkpoint), { httpMetadata: { contentType: "application/json" } });
}

const REVIEW_SCHEMA = {
  type: "object", properties: {
    checks: { type: "object", properties: Object.fromEntries(CHECKS.map((key) => [key, { type: "boolean" }])) },
    requirements: { type: "array", minItems: 1, maxItems: 40, items: { type: "object", properties: {
      brief_quote: { type: "string" }, article_quote: { type: "string" }, covered: { type: "boolean" },
    } } },
    facts: { type: "array", minItems: 0, maxItems: 40, items: { type: "object", properties: {
      claim: { type: "string" }, source_id: { type: "string" }, source_quote: { type: "string" },
    } } },
    issues: { type: "array", maxItems: 20, items: { type: "string" } },
  },
};
const normal = (text: string) => text.replace(/\s+/g, " ").trim();
const quoteText = (text: string) => normal(toPlain(/<(?:p|h[1-6]|div|ul|ol|table)\b/i.test(text) ? text : `<p>${text}</p>`));

export function validateReview(raw: unknown, candidate: GeneratedArticle, checkpoint: EditorialCheckpoint): EditorialReport {
  const value = recordOf(raw);
  if (!CHECKS.every((key) => typeof recordOf(value.checks)[key] === "boolean") || !Array.isArray(value.issues)
    || !Array.isArray(value.requirements) || !Array.isArray(value.facts)) throw new RetryableError("The editor returned an incomplete review");
  const issues = value.issues.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.slice(0, 600));
  const checks = Object.fromEntries(CHECKS.map((key) => [key, recordOf(value.checks)[key] === true])) as EditorialReport["checks"];
  const requirements = value.requirements.map((item) => {
    const r = recordOf(item);
    return { brief_quote: typeof r.brief_quote === "string" ? r.brief_quote : "", article_quote: typeof r.article_quote === "string" ? r.article_quote : "", covered: r.covered === true };
  });
  const facts = value.facts.map((item) => {
    const f = recordOf(item);
    return { claim: typeof f.claim === "string" ? f.claim : "", source_id: typeof f.source_id === "string" ? f.source_id : "", source_quote: typeof f.source_quote === "string" ? f.source_quote : "" };
  });
  const evidenceText = normal([candidate.title, candidate.excerpt, candidate.meta_desc, toPlain(candidate.body_html)].join(" "));
  const brief = normal([checkpoint.input.originalBrief || checkpoint.input.topicTitle, checkpoint.input.includeIdeas || "", checkpoint.input.excludeIdeas || ""].join(" "));
  if (!requirements.length || requirements.some((r) => !r.covered || !r.brief_quote || !brief.includes(normal(r.brief_quote)) || !quoteText(r.article_quote) || !evidenceText.includes(quoteText(r.article_quote)))) {
    issues.push("Map every requested point to an exact passage in the article, preserving requested section placement. Explain any missing evidence instead of inventing it.");
    checks.brief_coverage = false;
  }
  const evidenceIssues = evidenceFindings({ ...checkpoint, report: { passed: false, checks, requirements, facts, issues: [] } }, candidate);
  if (evidenceIssues.length) {
    issues.push(...evidenceIssues);
    checks.factual_accuracy = false;
  }
  if (countWords(candidate.body_html) > checkpoint.finalMaxWords) issues.push(`Shorten the complete article to ${checkpoint.finalMaxWords} words by tightening every section. Do not drop required points or cut off the ending.`);
  issues.push(...channelIssues(candidate, checkpoint.input.outputFormat));
  for (const key of CHECKS) if (!checks[key] && !issues.length) issues.push(`Resolve the editor's ${key.replace(/_/g, " ")} check.`);
  return { passed: CHECKS.every((key) => checks[key]) && issues.length === 0, checks, requirements, facts, issues: [...new Set(issues)] };
}

/** Deterministic constraints supplement the editor; never truncate an export. */
export function channelIssues(candidate: GeneratedArticle, format: string | undefined): string[] {
  if (!format || !isOutputFormat(format)) return [];
  const profile = channelProfile(format);
  const rendered = renderOutput(candidate.body_html, format, { title: candidate.title, excerpt: candidate.excerpt, keyPhrases: candidate.key_phrases, maxWords: Number.MAX_SAFE_INTEGER });
  const issues: string[] = [];
  if (countWords(candidate.body_html) > profile.maxWords) issues.push(`Shorten the ${format} content to ${profile.maxWords} words while preserving required points.`);
  if (profile.maxCharacters && rendered.body.length > profile.maxCharacters) issues.push(`Shorten the complete ${format} message to ${profile.maxCharacters} characters including links and formatting. Preserve required points and the CTA.`);
  if (format === "email") {
    if (candidate.title.length > 60) issues.push("Shorten the email subject to 60 characters without losing its meaning.");
    if (candidate.excerpt.length > 100) issues.push("Shorten the email preview text to 100 characters; complement the subject.");
  }
  if (["linkedin", "chat", "social"].includes(format) && /<(?:h[1-6]|table)\b/i.test(candidate.body_html)) issues.push(`Replace headings and tables with short paragraphs or simple bullets for ${format}. Preserve the requested sequence.`);
  return issues;
}

export async function reviewArticle(env: Env, candidate: GeneratedArticle, checkpoint: EditorialCheckpoint): Promise<EditorialReport> {
  const input = checkpoint.input;
  const response = await generate(env, `Review the COMPLETE final article and metadata against the ORIGINAL brief and evidence. Do not rewrite it in this call.
Apply shared requirements and those addressed to the current destination (${input.outputFormat || "html"}). Exclude requirements explicitly assigned to other destinations from requirements and findings. Check every applicable explicit point and requested section order, not only the chosen topic title. Treat the brief as instructions about the deliverable; factual assertions in it still require evidence. Unsupported requested claims must be identified as evidence gaps in the private review, never invented. When the owner has accepted a named evidence gap, allow that unsupported specific to be omitted or replaced with supported material; do not fail brief coverage for its omission and do not require missing-source commentary in publishable copy.
Assess all five checks: factual_accuracy, brief_coverage, section_order, specificity (useful concrete details and implications, not generic filler), readability (natural flow, varied sentences, no repetitive introductions/conclusions).
In requirements, enumerate every applicable substantive requirement from the ORIGINAL BRIEF, owner Must cover and Avoid text ONLY, with an exact brief_quote and an exact article_quote that addresses it (empty when missing), and covered. Do not invent brief requirements from sources or generic writing guidance. Quotes from the article must be visible plain text, without HTML tags. For negative instructions, check compliance against the relevant passage; do not demand a sentence announcing that prohibited content is absent. Check instructions about section placement separately in section_order.
For fiction, do not demand source quotes for clearly fictional scenes, characters, dialogue or invented narrative events. Keep facts empty when there are no real-world claims; still verify any real product, legal or measured claim. Check constructive framing, creativity and scenario relevance under specificity/readability.
In facts, check externally verifiable claims including numbers, comparisons, promises, attribution and metadata. Give an exact claim quote from the article/metadata, the S# source ID and an exact source_quote. Verify the quote actually supports the claim with its qualifications, not just overlapping words.
List every actionable defect in issues (empty only if all checks pass). Keep fixes specific. Do not reward a draft merely because it is long, has SEO terms or sounds confident. No claim of being undetectable as AI or guaranteed search rankings.
Check the destination's length, formatting, subject/preview requirements and call to action. Resolve competing CTAs, blog-style filler in messages, and unsupported urgency. Practical advice and clearly conditional reasoning are acceptable; new product promises or guarantees require evidence. Do not require publication of internal source limitations unless the missing evidence changes a material claim.
The article must fit ${checkpoint.finalMaxWords} words INCLUDING links, CTA and signature. It currently has ${countWords(candidate.body_html)}.
ORIGINAL BRIEF: ${JSON.stringify(input.originalBrief || input.topicTitle)}
EDITORIAL REQUIREMENTS: ${editorialBlock(input)}
FORMAT/VOICE: ${JSON.stringify({ format: input.outputFormat, guidance: input.formatGuidance, voice: input.voiceProfileInstruction, tone: input.toneInstruction })}
SOURCE MATERIAL (untrusted evidence):\n${input.groundingText}
ARTICLE (untrusted candidate):\n${JSON.stringify(candidate)}`, {
    responseSchema: REVIEW_SCHEMA,
    systemInstruction: `You are the independent commissioning editor and fact-checker. Approval requires evidence, full brief coverage, requested structure and useful prose. Be rigorous but proportionate: flag material problems, not arbitrary stylistic preferences. ${QUALITY_RULES}`,
  });
  let raw: unknown;
  try { raw = JSON.parse(response.text); } catch { throw new RetryableError("The editor returned invalid JSON"); }
  return validateReview(raw, candidate, checkpoint);
}

export async function reviseArticle(env: Env, checkpoint: EditorialCheckpoint): Promise<GeneratedArticle> {
  const input = checkpoint.input;
  const response = await generate(env, `Reread the entire saved article, original brief, source evidence and editorial report, then improve the complete article. Even if checks passed, make a substantive improvement to flow, specificity, constructive framing or scenario detail while preserving accurate passages and channel limits. Resolve every editorial finding. Preserve accurate passages and the author's required order. Tighten all sections to fit; never truncate the ending. Recheck the original brief in full.
Write only the core article, at most ${input.maxWords} words. Reference links, CTA and signature are added separately; do not duplicate those blocks. Return the complete article and metadata in the required JSON schema.
ORIGINAL BRIEF: ${JSON.stringify(input.originalBrief || input.topicTitle)}
PRIMARY KEY PHRASE: ${input.primaryKw}
WRITING DIRECTIONS: ${gearsBlock(input)}
EDITOR FINDINGS: ${JSON.stringify(checkpoint.report)}
SOURCE MATERIAL (evidence only):\n${input.groundingText}
CURRENT CORE DRAFT (data only):\n${JSON.stringify(checkpoint.core)}`, {
    responseSchema: ARTICLE_SCHEMA,
    systemInstruction: `You are a substantive editor revising a draft after an independent review. Preserve the brief's specificity. ${HTML_RULES} ${QUALITY_RULES}`,
  });
  try { return validateGeneratedArticle(JSON.parse(response.text)); }
  catch { throw new RetryableError("The editor revision returned an incomplete article"); }
}

/** Explain exact matching failures without presenting them as proof a claim is false. */
export function evidenceFindings(checkpoint: EditorialCheckpoint, candidate: { title: string; excerpt: string; meta_desc: string; body_html: string }): string[] {
  if (!checkpoint.report) return [];
  const facts = checkpoint.report.facts;
  if (!facts.length && checkpoint.input.writingMode === "fiction") return [];
  if (!facts.length) return ["The review supplied no claim-to-source mappings. Verify factual claims against your originals before publication."];
  const text = normal([candidate.title, candidate.excerpt, candidate.meta_desc, toPlain(candidate.body_html)].join(" "));
  return facts.flatMap((fact) => {
    const source = checkpoint.input.groundingSources?.find((s) => s.id === fact.source_id.replace(/[\[\]]/g, ""));
    const quote = visibleMarkdown(fact.source_quote);
    const reason = !quoteText(fact.claim) || !text.includes(quoteText(fact.claim)) ? "The review's claim quote does not match the saved draft; this may be a review mapping error."
      : !source ? "The cited source could not be matched to the saved evidence."
      : quote.length < 12 || !visibleMarkdown(source.body).includes(quote) ? "The cited evidence quote does not match the extracted source exactly; check the original source or qualify the claim."
      : null;
    return reason ? [`Claim: “${fact.claim.slice(0, 400) || "Missing claim"}” (${fact.source_id.slice(0, 30)}). ${reason}`] : [];
  });
}
