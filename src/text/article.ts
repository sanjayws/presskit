/**
 * Agentic article generation. Instead of one giant call, the writer works like
 * a human: it PLANS first (title, metadata, and a section-by-section outline),
 * then WRITES each section in a loop, one Claude Opus 5.5 call at a time, with every
 * section aware of the outline and the sections already written so the piece
 * reads as one coherent article. Finally the blocks are assembled into
 * body_html. HTML-direct throughout; no Markdown, no inline SVG.
 *
 * The exported contract (`generateArticle` -> `GeneratedArticle`) is unchanged,
 * so the downstream style/normalize/sanitize pipeline stays the same.
 */
import type { Env } from "../env";
import { generate, extractJson } from "../anthropic/client";
import { logEvent } from "../log";
import { articleProgress } from "../db/repos";
import { RetryableError } from "../errors";
import { QUALITY_RULES } from "./instructions";
import { recordOf } from "../providers/http";
import type { OutputFormat } from "../style/engine";
import { marketingAgentInstructions } from "../marketing/skills";
import { sha256Hex } from "../grounding/ingest";
import type { GroundingSource } from "../grounding/evidence";

export interface GeneratedArticle {
  title: string;
  body_html: string;
  excerpt: string;
  meta_desc: string;
  slug: string;
  key_phrases: string[];
}

export interface SectionPlan {
  heading: string;
  points: string[];
}

export interface ArticlePlan {
  title: string;
  slug: string;
  meta_desc: string;
  excerpt: string;
  key_phrases: string[];
  intro_goal: string;
  sections: SectionPlan[];
}

/** JSON schema for the planning call (structure only, no prose). */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    slug: { type: "string" },
    meta_desc: { type: "string" },
    excerpt: { type: "string" },
    key_phrases: { type: "array", items: { type: "string" } },
    intro_goal: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          points: { type: "array", items: { type: "string" } },
        },
        required: ["heading", "points"],
      },
    },
  },
  required: [
    "title",
    "slug",
    "meta_desc",
    "excerpt",
    "key_phrases",
    "intro_goal",
    "sections",
  ],
} as const;

// Shared HTML house rules, injected into both the planner and every section
// writer so the fragments compose cleanly and paste into Elementor/WordPress.
export const HTML_RULES = `HTML rules (strict):
- Output HTML-direct. NEVER Markdown, never code fences.
- Allowed tags only: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <blockquote>, <a>, <strong>, <em>, and a simple <table> (<thead>,<tbody>,<tr>,<th>,<td>) for comparisons.
- NO <svg>, <img>, <script>, <style>, no "style" attributes, no fixed widths or absolute positioning. Everything sits in normal flow so nothing overflows its container.
- Prefer a clean <table> for comparisons with short cell text (no long sentences that bleed out of cells). Otherwise use lists.
- Do not use em-dashes or en-dashes.
- Stay strictly grounded in the supplied material and topic. Do not invent facts.`;

const PLAN_SYSTEM = `You are an expert SEO content strategist. Plan a specific, evidence-led article with a useful headline, clean metadata and a non-overlapping outline that answers the reader's intent. Return only the JSON object. ${QUALITY_RULES}`;

const SECTION_SYSTEM = `You are an expert article writer completing ONE section of a larger article that is already planned. Write only the requested section so it flows naturally from what came before, never repeats earlier sections, and never restates the article title. ${HTML_RULES} ${QUALITY_RULES}`;

export interface ArticleInput {
  /** The full owner brief must survive angle selection and every writing call. */
  originalBrief?: string;
  topicTitle: string;
  angle: string;
  primaryKw: string;
  voiceProfileInstruction: string;
  personaInstruction?: string;
  toneInstruction?: string;
  temperature?: number;
  maxWords: number;
  groundingText: string;
  groundingSources?: GroundingSource[];
  /** Optional editorial controls (owner-supplied). */
  includeIdeas?: string;
  excludeIdeas?: string;
  /** 1..5. 1 = strictly neutral/honest, 5 = strongly promotional. Default 3. */
  biasLevel?: number;
  /** Article-type writing guidance (comparison, listicle, news, ...). */
  articleTypeInstruction?: string;
  /** Target-platform writing guidance (e.g. social = short, no tables). */
  formatGuidance?: string;
  /** Explicit format for skill routing; never infer it from free-text guidance. */
  outputFormat?: OutputFormat;
  /** When set, plan + completed sections are checkpointed so a retry resumes. */
  progressKey?: { runId: string; topicId: string };
}

/**
 * Maps the 1..5 bias dial to an editorial stance. The extreme promotional end
 * (5) still forbids fabrication: it shifts emphasis, selection and framing only,
 * so "ground or refuse" holds regardless of the dial.
 */
export function biasInstruction(level: number): string {
  switch (level) {
    case 1:
      return "Editorial stance: strictly neutral and honest. Report reality objectively, including limitations, trade-offs and downsides where the sources show them. Do not promote or advocate for anything.";
    case 2:
      return "Editorial stance: mostly neutral and factual, with a lightly favourable framing only where the grounding material genuinely supports it. Still acknowledge relevant caveats.";
    case 4:
      return "Editorial stance: persuasive and promotional. Lead with supported strengths, benefits and value. Keep explanations concise, but never omit or minimise material limitations. Stay factual: never invent claims the sources do not support, and never predetermine a comparison verdict.";
    case 5:
      return "Editorial stance: strongly promotional advocacy. Emphasise supported benefits and explain who the grounded product is a good fit for. You must remain fully grounded and must not fabricate facts, statistics or claims the sources do not support. Never conceal material limitations or predetermine comparison verdicts; emphasis cannot override evidence.";
    case 3:
    default:
      return "Editorial stance: balanced and constructive. Present the subject positively where warranted while staying honest and useful, giving a fair, well-rounded view.";
  }
}

/** Owner editorial directives: what to include, what to exclude, and the bias stance. */
export function editorialBlock(input: ArticleInput): string {
  const parts: string[] = [];
  if (input.originalBrief) parts.push(`Original owner brief (deliverable instructions; claims are not evidence): ${JSON.stringify(input.originalBrief)}\nPreserve every requested point, explicit heading, section placement and sequence. The selected angle refines this brief; it never replaces it. Flag evidence gaps rather than silently dropping requested points.`);
  const inc = input.includeIdeas?.trim();
  const exc = input.excludeIdeas?.trim();
  if (inc) {
    parts.push(
      `Must cover where supported (owner preference, not factual evidence): ${JSON.stringify(inc)}`,
    );
  }
  if (exc) {
    parts.push(`Must avoid as optional topics (owner preference, never conceal or contradict a material limitation): ${JSON.stringify(exc)}`);
  }
  parts.push(biasInstruction(input.biasLevel ?? 3));
  return parts.join("\n");
}

export function gearsBlock(input: ArticleInput): string {
  return [
    `Voice: ${input.voiceProfileInstruction}`,
    input.personaInstruction ? `Author: ${input.personaInstruction}` : "",
    input.toneInstruction ? input.toneInstruction : "",
    (input.temperature ?? 0.6) < 0.5 ? "Phrasing: restrained, direct and consistent." : (input.temperature ?? 0.6) > 0.8 ? "Phrasing: vary rhythm and openings while keeping precise evidence and qualifications." : "Phrasing: natural, clear and specific; avoid stock marketing language.",
    // Type first, then editorial emphasis. Neither can override evidence rules.
    input.articleTypeInstruction ? input.articleTypeInstruction : "",
    editorialBlock(input),
    input.formatGuidance ? input.formatGuidance : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function groundingBlock(input: ArticleInput): string {
  // Sources are numbered [S1], [S2], ... Tell the model to attribute each claim
  // to a specific numbered source internally, but never to print those ids in
  // the article (this is a published article, not an academic paper).
  return `The sources below are numbered [S1], [S2], and so on. Use only facts you
can attribute to a specific numbered source; do not blend sources or invent
details. Do NOT print the [S#] markers or any citation numbers in the article
text itself.

${input.groundingText}`;
}

/** Below this length, one structured call beats plan+intro+sections. */
const SHORT_ARTICLE_WORDS = 500;

/**
 * Section count derived from the word cap so the outline can actually fit. Each
 * section is planned for roughly PLAN_WORDS_PER_SECTION words; bounded to a sane
 * range. Used both to prompt the planner and to validate what it returns.
 */
const PLAN_WORDS_PER_SECTION = 320;
export function planSectionCount(maxWords: number): number {
  const n = Math.round((maxWords * 0.85) / PLAN_WORDS_PER_SECTION);
  return Math.max(2, Math.min(6, n));
}

/** Step 1: plan the whole article (metadata + outline). */
function buildPlanPrompt(input: ArticleInput): string {
  const sectionHint = planSectionCount(input.maxWords);
  return `Plan one article. Do not write the article body yet.

Topic: ${input.topicTitle}
Angle: ${input.angle}
Primary key phrase: ${input.primaryKw}
Total target length: about ${input.maxWords} words.

Writer intent (for tone/voice, so the plan fits the eventual voice):
${gearsBlock(input)}

Grounding material (plan strictly within it; do not invent facts):
${groundingBlock(input)}

Produce:
- title: a strong, specific headline (not clickbait).
- slug: kebab-case, lowercase, ascii.
- meta_desc: <= 155 characters, compelling, includes the primary key phrase.
- excerpt: 1 to 2 sentence summary.
- key_phrases: 4 to 8 short SEO phrases.
- intro_goal: one sentence describing what the opening paragraph(s) must accomplish (the hook and what the reader will get).
- sections: use the owner's explicit headings and sequence when supplied, keeping points in the requested sections. Otherwise aim for about ${sectionHint} useful sections with no overlap. Each section has a heading (becomes an <h2>) and the concrete points it must cover. Prefer specific, source-supported explanations over generic benefits. Do not force a conclusion section or rename/reorder explicit owner headings. Fit the whole plan within the word budget.`;
}

/** Total wall-clock budget for one article's section loop. */
const ARTICLE_DEADLINE_MS = 120_000;

/**
 * Word budget for one section, leaving ~15% for the intro. The floor scales with
 * the cap (small floor for short articles) so section budgets cannot structurally
 * exceed the total maximum.
 */
export function sectionWordBudget(maxWords: number, sectionCount: number): number {
  const forSections = Math.floor(maxWords * 0.85);
  const perSection = Math.floor(forSections / Math.max(1, sectionCount));
  return Math.max(12, perSection);
}

/** Step 2a: prompt for the intro block (no heading, just the opening). */
function buildIntroPrompt(input: ArticleInput, plan: ArticlePlan): string {
  const outline = plan.sections.map((s, i) => `${i + 1}. ${s.heading}`).join("\n");
  return `Write ONLY the opening of this article (no heading, no title). At most ${Math.floor(input.maxWords * 0.12)} words, in 1 to 2 short paragraphs. Start with the useful answer, not a general introduction to the industry.

Article title: ${plan.title}
Primary key phrase: ${input.primaryKw}
Opening goal: ${plan.intro_goal}

The article will then cover these sections (do not write them now, just set them up naturally):
${outline}

Writer instructions:
${gearsBlock(input)}

Grounding material (stay within it):
${groundingBlock(input)}

Return only the opening paragraph(s) as HTML <p> element(s). No <h2>, no code fences, no commentary.`;
}

/** Step 2b: prompt for one section, aware of what is already written. */
function buildSectionPrompt(
  input: ArticleInput,
  plan: ArticlePlan,
  index: number,
  writtenSoFar: string,
): string {
  const s = plan.sections[index];
  if (!s) throw new Error(`no section at index ${index}`);
  const budget = sectionWordBudget(input.maxWords, plan.sections.length);
  const outline = plan.sections
    .map((x, i) => `${i + 1}. ${x.heading}${i === index ? "  <- WRITE THIS ONE" : ""}`)
    .join("\n");
  // Give the model the tail of what is written so it maintains flow without
  // re-reading the entire article (kept small; articles are <= 2000 words).
  const context = writtenSoFar.slice(-6000);

  return `Write ONLY section ${index + 1} of this article.

Article title: ${plan.title}
Primary key phrase: ${input.primaryKw}

Full outline (for context, so you do not repeat other sections):
${outline}

This section heading: ${s.heading}
This section must cover:
${s.points.map((p) => `- ${p}`).join("\n")}
Target length for this section: about ${budget} words.

What has already been written (continue smoothly from this; do NOT repeat it):
${context || "(nothing yet, this is the first section)"}

Writer instructions:
${gearsBlock(input)}

Grounding material (stay strictly within it, cite specifics, do not fabricate):
${groundingBlock(input)}

Return this section as HTML starting with <h2>${s.heading}</h2> followed by the section body (<p>, <ul>/<ol>, or a <table> if it genuinely helps). No code fences, no commentary, no other sections.`;
}

/** Strip stray code fences / leading prose a model may add around a fragment. */
function cleanFragment(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  return t.trim();
}

/** A usable section fragment is non-empty and contains at least one HTML tag. */
function isHtmlFragment(s: string): boolean {
  return s.trim().length > 0 && /<[a-z][\s\S]*>/i.test(s);
}

// Single-call path for short articles: plan+intro+sections is wasteful and its
// section budgets can't fit a tiny cap, so generate the whole thing at once.
export const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body_html: { type: "string" },
    excerpt: { type: "string" },
    meta_desc: { type: "string" },
    slug: { type: "string" },
    key_phrases: { type: "array", items: { type: "string" } },
  },
  required: ["title", "body_html", "excerpt", "meta_desc", "slug", "key_phrases"],
} as const;

const SHORT_SYSTEM = `You write useful, grounded content for the specified destination as clean semantic HTML. Follow channel-specific subject, length and formatting rules. Negative instructions such as 'do not invent savings' are internal constraints: comply by omitting invented savings, not by adding a sentence about missing sources. Do not add unsolicited discussion of the brief, evidence collection or your writing process. ${HTML_RULES} ${QUALITY_RULES}`;

async function generateShortArticle(
  env: Env,
  input: ArticleInput,
): Promise<GeneratedArticle> {
  const prompt = `Write one short article (about ${input.maxWords} words, hard maximum ${input.maxWords}).

Topic: ${input.topicTitle}
Angle: ${input.angle}
Primary key phrase: ${input.primaryKw}

Writer instructions:
${gearsBlock(input)}

Grounding material (stay strictly within it, cite specifics, do not fabricate):
${groundingBlock(input)}

Return JSON: title, body_html (short <p> paragraphs, optionally a <ul>; use <h2> subheadings only when they genuinely help and the writer instructions above do not forbid them), excerpt, meta_desc (<=155 chars), slug (kebab-case), key_phrases (4 to 8).`;
  const res = await generate(env, prompt, {
    responseSchema: ARTICLE_SCHEMA,
    systemInstruction: `${SHORT_SYSTEM}\n\n${marketingAgentInstructions("short-article", input)}`,
  });
  let p: Record<string, unknown>;
  try {
    p = recordOf(JSON.parse(res.text));
  } catch {
    throw new RetryableError("short article generation returned invalid JSON");
  }
  logEvent("article.short", { words: input.maxWords });
  return validateGeneratedArticle(p);
}

export function validateGeneratedArticle(raw: unknown): GeneratedArticle {
  const p = recordOf(raw);
  if (typeof p.title !== "string" || !p.title.trim() || typeof p.body_html !== "string"
    || !isHtmlFragment(p.body_html) || !p.body_html.replace(/<[^>]*>/g, "").trim()) {
    // A malformed single response is usually a transient model hiccup: retry.
    throw new RetryableError("short article generation returned an incomplete object");
  }
  return {
    title: p.title.trim(),
    body_html: p.body_html,
    excerpt: typeof p.excerpt === "string" ? p.excerpt : "",
    meta_desc: typeof p.meta_desc === "string" ? p.meta_desc : "",
    slug: typeof p.slug === "string" ? p.slug : "",
    key_phrases: Array.isArray(p.key_phrases) ? p.key_phrases.filter((value): value is string => typeof value === "string" && !!value.trim()) : [],
  };
}

export async function planArticle(
  env: Env,
  input: ArticleInput,
): Promise<ArticlePlan> {
  const res = await generate(env, buildPlanPrompt(input), {
    responseSchema: PLAN_SCHEMA,
    systemInstruction: `${PLAN_SYSTEM}\n\n${marketingAgentInstructions("article-plan", input)}`,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    raw = extractJson<unknown>(res.text);
  }
  return validatePlan(raw);
}

/** Coerce + validate the planner's JSON into a well-formed ArticlePlan or throw. */
function validatePlan(raw: unknown): ArticlePlan {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const title = str(o.title);
  const sectionsIn = Array.isArray(o.sections) ? o.sections : [];
  const sections: SectionPlan[] = sectionsIn
    .map((s) => {
      const so = (s ?? {}) as Record<string, unknown>;
      const heading = str(so.heading);
      const points = (Array.isArray(so.points) ? so.points : [])
        .map(str)
        .filter(Boolean);
      return { heading, points };
    })
    .filter((s) => s.heading.length > 0);
  if (sections.length > 20) throw new Error("The outline has too many sections for a single article. Narrow the brief or increase the scope separately.");
  if (!title || sections.length === 0) {
    throw new Error("article planning returned an empty or invalid outline");
  }
  return {
    title,
    slug: str(o.slug),
    meta_desc: str(o.meta_desc),
    excerpt: str(o.excerpt),
    key_phrases: (Array.isArray(o.key_phrases) ? o.key_phrases : [])
      .map(str)
      .filter(Boolean),
    intro_goal: str(o.intro_goal),
    sections,
  };
}

/**
 * Agentic generation: plan, then write intro + each section in a loop, then
 * assemble. Returns the same GeneratedArticle contract as before.
 */
export class DraftPendingError extends Error {}

export async function generateArticle(
  env: Env,
  input: ArticleInput,
): Promise<GeneratedArticle> {
  const fingerprint = await sha256Hex(JSON.stringify(["anthropic-editorial-v1", env.ANTHROPIC_MODEL, env.ANTHROPIC_EFFORT, input]));
  // Short articles: one structured call (cheaper, and the sectioned budget can't
  // fit a tiny cap anyway).
  if (input.maxWords < SHORT_ARTICLE_WORDS) {
    const key = input.progressKey;
    const previous = key ? await articleProgress.load(env.DB, key.runId, key.topicId) : null;
    if (previous) {
      try {
        const saved = JSON.parse(previous.sections_json) as { fingerprint?: string; draft?: unknown };
        if (saved.fingerprint === fingerprint && saved.draft) return validateGeneratedArticle(saved.draft);
      } catch { /* A corrupt or old checkpoint starts a fresh draft. */ }
    }
    const draft = await generateShortArticle(env, input);
    if (key) await articleProgress.save(env.DB, key.runId, key.topicId, "{}", JSON.stringify({ fingerprint, draft }));
    return draft;
  }

  const pk = input.progressKey;
  const sectionSystem = `${SECTION_SYSTEM}\n\n${marketingAgentInstructions("article-write", input)}`;

  // Resume from a checkpoint if a prior attempt got partway, otherwise plan and
  // write the intro fresh. Sections already written are never regenerated.
  let plan: ArticlePlan | null = null;
  let intro = "";
  let introDone = false;
  const sections: string[] = [];
  if (pk) {
    const saved = await articleProgress.load(env.DB, pk.runId, pk.topicId);
    if (saved) {
      try {
        const parsedPlan = JSON.parse(saved.plan_json) as ArticlePlan;
        const body = JSON.parse(saved.sections_json) as { fingerprint?: string; intro?: string; introDone?: boolean; sections?: string[] };
        if (parsedPlan?.sections?.length && body.fingerprint === fingerprint) {
          plan = parsedPlan;
          intro = typeof body.intro === "string" ? body.intro : "";
          introDone = body.introDone ?? !!intro;
          if (Array.isArray(body.sections)) sections.push(...body.sections.map(String));
          logEvent("article.resume", { done: sections.length, of: plan.sections.length });
        }
      } catch {
        plan = null; // corrupt checkpoint: fall through to a fresh plan
      }
    }
  }

  const save = async () => {
    if (!pk || !plan) return;
    await articleProgress.save(
      env.DB,
      pk.runId,
      pk.topicId,
      JSON.stringify(plan),
      JSON.stringify({ fingerprint, intro, introDone, sections }),
    );
  };

  if (!plan) {
    plan = await planArticle(env, input);
    logEvent("article.plan", { sections: plan.sections.length });
    await save();
    if (pk) throw new DraftPendingError("Outline saved; continue with the opening");
  }
  if (!introDone) {
    const introRes = await generate(env, buildIntroPrompt(input, plan), { systemInstruction: sectionSystem });
    intro = cleanFragment(introRes.text);
    if (!isHtmlFragment(intro)) throw new RetryableError("The opening contained no usable HTML");
    introDone = true;
    await save();
    if (pk) throw new DraftPendingError("Opening saved; continue with sections");
  }

  // Total wall-clock budget for the section loop, so one slow article cannot
  // monopolise the queue consumer. On expiry we DO NOT ship a partial article:
  // the completed sections are checkpointed, so we throw a retryable error and
  // the next queue delivery resumes from where we stopped and finishes the plan.
  const deadline = Date.now() + ARTICLE_DEADLINE_MS;
  let written = [intro, ...sections].filter(Boolean).join("\n");
  for (let i = sections.length; i < plan.sections.length; i++) {
    if (Date.now() > deadline) {
      logEvent("article.deadline", { wrote: sections.length, planned: plan.sections.length });
      throw new RetryableError(
        `article section deadline: wrote ${sections.length}/${plan.sections.length}, resuming`,
      );
    }
    let fragment = "";
    // Retry if a section comes back empty or without any HTML tag. Cap each call
    // to the remaining budget so the deadline is a real wall-clock bound.
    for (let attempt = 0; attempt < 2 && !isHtmlFragment(fragment); attempt++) {
      const res = await generate(env, buildSectionPrompt(input, plan, i, written), {
        systemInstruction: sectionSystem,
        timeoutMs: deadline - Date.now(),
      });
      fragment = cleanFragment(res.text);
    }
    // Never checkpoint an empty slot as "done": that would permanently drop a
    // planned section. Fail retryably instead, keeping the good sections so far.
    if (!isHtmlFragment(fragment)) {
      throw new RetryableError(
        `article section ${i + 1}/${plan.sections.length} produced no usable HTML, retrying`,
      );
    }
    sections.push(fragment);
    written += "\n" + fragment;
    await save();
    logEvent("article.section", { index: i + 1, of: plan.sections.length, ok: true });
    if (pk && sections.length < plan.sections.length) throw new DraftPendingError("Section saved; continue writing");
  }

  // Every planned section is now present. Assemble and require a non-empty body.
  const parts = [intro, ...sections].filter((p) => p && p.trim());
  const body_html = parts.join("\n");
  if (sections.length < plan.sections.length || !body_html.trim()) {
    throw new RetryableError("agentic article generation incomplete");
  }

  return {
    title: plan.title,
    body_html,
    excerpt: plan.excerpt,
    meta_desc: plan.meta_desc,
    slug: plan.slug,
    key_phrases: plan.key_phrases,
  };
}
