/** Grounded topic proposal using Anthropic web search for reader intent.
 * Search does not silently add factual evidence to the writer's source set.
 */
import type { Env } from "../env";
import { extractJson, generate } from "../anthropic/client";
import { topics as topicsRepo, type Topic } from "../db/repos";
import { stripSourceMarkers } from "../style/lint";
import { sanitizeKeyPhrase } from "../content/validate";
import { RetryableError } from "../errors";
import { QUALITY_RULES } from "./instructions";
import { marketingAgentInstructions } from "../marketing/skills";

const REQUIRED_TOPICS = 3;
const MAX_TOPIC_ATTEMPTS = 2; // internal; the queue can still retry the stage
const MAX_TITLE_LEN = 120;
const MAX_SUMMARY_LEN = 300;
const MAX_KW_LEN = 80;
const MAX_ANGLE_LEN = 60;

/**
 * Keep genuinely distinct angles: drop duplicate titles, and duplicate angles
 * (case-insensitive) except the generic "General overview" fallback, which is
 * treated as always-unique so real distinct titles are not collapsed.
 */
function dedupeDistinct(list: ProposedTopic[]): ProposedTopic[] {
  const titles = new Set<string>();
  const angles = new Set<string>();
  const out: ProposedTopic[] = [];
  for (const t of list) {
    const tk = t.title.toLowerCase();
    const ak = t.angle.toLowerCase();
    const generic = ak === "general overview";
    if (titles.has(tk)) continue;
    if (!generic && angles.has(ak)) continue;
    titles.add(tk);
    if (!generic) angles.add(ak);
    out.push(t);
  }
  return out;
}

export interface ProposedTopic {
  title: string;
  angle: string;
  summary: string;
  primary_kw: string;
  volume: number | null;
  difficulty: number | null;
}

const SYSTEM = `You are an SEO strategist. Use live web search to research the idea and
identify useful keywords and questions relevant to the audience. Do not claim measured search
demand or ranking potential without a real keyword metrics source.
Return ONLY a JSON array of exactly 3 objects (the 3 strongest, distinct angles), no prose, no code fence.
Each object:
{"title": string, "angle": string, "summary": string, "primary_kw": string, "volume": null, "difficulty": null}
- title: a specific, compelling, publishable article title targeting that keyword.
- angle: a few words naming the unique take (e.g. "cost-savings angle", "beginner how-to").
- summary: 1 to 2 sentences describing what the finished article would cover and who it helps. Written for the author to choose between angles.
- primary_kw: the high-value key phrase to rank for.
- volume and difficulty: return null. Web search is not a keyword metrics tool; never invent numerical SEO measurements.
- Only propose angles the supplied material can substantiate. Search informs reader intent; it does not add unverified product or competitor claims to the article's evidence.
The 3 must be genuinely DIFFERENT angles on the idea, not variations of one title. Rank by relevance, evidence coverage and usefulness. ${QUALITY_RULES}`;

function buildPrompt(idea: string, groundingSummary: string, researchGuidance: string): string {
  const year = new Date().getFullYear();
  return `Campaign idea:
${idea}
${researchGuidance ? `\n${researchGuidance}\n` : ""}
Grounding material from the user's own sites and docs (use it to stay on-brand and specific):
${groundingSummary}

Research this idea's search landscape and return exactly 3 strong, DISTINCT SEO angles,
ranked best-first, each as a publishable topic grounded in the material above, each with a
1 to 2 sentence summary of the article it would become.

Freshness: use credible current search results to understand reader intent (${year}).
Do not present undated or older product evidence as newly verified. Add years, "latest",
or time-sensitive claims only when the supplied evidence supports them.`;
}

/** Call Claude Opus 5.5 and normalize to up to 3 distinct, clean topic objects. */
export async function proposeTopics(
  env: Env,
  idea: string,
  groundingSummary: string,
  researchGuidance = "",
): Promise<ProposedTopic[]> {
  const res = await generate(env, buildPrompt(idea, groundingSummary, researchGuidance), {
    webSearch: true,
    systemInstruction: `${SYSTEM}\n\n${marketingAgentInstructions("topic-research")}`,
  });

  const raw = extractJson<any[]>(res.text);
  if (!Array.isArray(raw)) throw new Error("topics reply was not an array");

  const mapped = raw
    .filter((t) => t && typeof t.title === "string" && typeof t.primary_kw === "string")
    .map<ProposedTopic>((t) => {
      const angle =
        stripSourceMarkers(String(t.angle ?? "").trim()).slice(0, MAX_ANGLE_LEN) ||
        "General overview";
      return {
        title: stripSourceMarkers(String(t.title).trim()).slice(0, MAX_TITLE_LEN),
        angle,
        // Never empty: fall back to the angle so the picker always shows a summary.
        summary:
          stripSourceMarkers(String(t.summary ?? "").trim()).slice(0, MAX_SUMMARY_LEN) || angle,
        // Focus-keyphrase clean (Yoast etc. reject commas/punctuation in one).
        primary_kw: sanitizeKeyPhrase(stripSourceMarkers(String(t.primary_kw))).slice(
          0,
          MAX_KW_LEN,
        ),
        // No numerical metrics feed is configured; never present guesses as measurements.
        volume: null,
        difficulty: null,
      };
    })
    .filter((t) => t.title.length > 0 && t.primary_kw.length > 0);

  // Distinct by BOTH title and angle (case-insensitive): the three must be
  // genuinely different takes, not re-titles of one idea. Preserve the model's
  // evidence/relevance order; fabricated numeric scores must never reorder it.
  return dedupeDistinct(mapped);
}

/** Propose and atomically swap in topics for a run (old set survives failure). */
export async function generateTopicsForRun(
  env: Env,
  campaignId: string,
  runId: string,
  idea: string,
  groundingSummary: string,
  /** Article-type research guidance (e.g. comparison = research the contenders). */
  researchGuidance = "",
): Promise<Topic[]> {
  // Accumulate DISTINCT angles across bounded attempts and MERGE them (two
  // 2-angle responses with different takes can together satisfy the contract),
  // rather than keeping whichever single response happened to be richer.
  const collected: ProposedTopic[] = [];
  for (
    let attempt = 0;
    attempt < MAX_TOPIC_ATTEMPTS && dedupeDistinct(collected).length < REQUIRED_TOPICS;
    attempt++
  ) {
    collected.push(...(await proposeTopics(env, idea, groundingSummary, researchGuidance)));
  }

  const distinct = dedupeDistinct(collected);
  // Enforce the "exactly three" contract: never render a partial selector. A
  // shortfall is retryable (topic generation is stochastic; the queue retries).
  if (distinct.length < REQUIRED_TOPICS) {
    throw new RetryableError(
      `topic proposal produced ${distinct.length}/${REQUIRED_TOPICS} distinct angles`,
    );
  }
  return topicsRepo.replaceForRun(
    env.DB,
    campaignId,
    runId,
    distinct.slice(0, REQUIRED_TOPICS),
  );
}
