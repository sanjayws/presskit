import { acceptedGapsGuidance } from "../editorial/accepted-gaps";
import { selectedChannels } from "../style/channels";
/**
 * Run orchestration. One function per pipeline stage. Each stage advances run
 * state and enqueues the next stage. Any throw is caught by the queue consumer,
 * which records a service failure. Evidence readiness pauses before writing.
 */
import type { Env, PipelineMessage } from "../env";
import {
  articleProgress,
  articles as articlesRepo,
  campaigns,
  runs,
  topics as topicsRepo,
  users,
} from "../db/repos";
import { groundingForRun, groundingEvidenceForRun, ingestSources } from "../grounding/report";
import { generateTopicsForRun } from "../text/topics";
import { generateArticle, DraftPendingError } from "../text/article";
import { prepareArticle } from "../content/finalize";
export { appendSignature } from "../content/finalize";
import { saveEditorial, type EditorialCheckpoint } from "../editorial/review";
import {
  voiceInstruction,
  optionInstruction,
  articleTypeByValue,
  clampTemperature,
  ctaByValue,
  buildCtaHref,
  countWords,
  PERSONAS,
  TONES,
  formatWriterGuidance,
  channelProfile,
  isCampaignChannel,
} from "../style/engine";
import { renderOutput, isRichFormat } from "../content/render";
import { renderFeaturedVisual } from "../images/render";
import { imageFailureMessage } from "../images/errors";
import { imageJobs } from "../db/image-jobs";
import { RetryableError, StageBusyError } from "../errors";
import { sendReadyEmail } from "../notify/postmark";
import { enrichmentReserveWords, readReferenceLinks } from "../content/enrich";
import { buildBundle } from "../bundle/export";
import type { Article, ArticleInsert } from "../db/repos";
import {
  articleSignature,
  mostSimilar,
  SIMILAR_THRESHOLD,
  type PriorArticle,
} from "../content/similarity";
import { logEvent } from "../log";
import { scheduleStage, getRecovery, advanceResearch } from "./recovery";
import { assessReadiness, loadReadiness } from "../grounding/readiness";

async function enqueue(env: Env, msg: PipelineMessage): Promise<void> {
  await scheduleStage(env, msg);
}

/** Build a compact summary of an article to feed the image model. */
export function articleImageSummary(a: Article): string {
  const headings = [...a.body_html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  let kp: string[] = [];
  try {
    const parsed = JSON.parse(a.key_phrases);
    if (Array.isArray(parsed)) kp = parsed.map(String);
  } catch {
    /* ignore */
  }
  return [
    a.excerpt,
    headings.length ? `Key sections: ${headings.join("; ")}` : "",
    kp.length ? `Key phrases: ${kp.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1500);
}

/** Stage: resolve source availability before the separate readiness check. */
export async function stageIngest(env: Env, runId: string): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.state !== "drafting_topics") return;
  const owner = await runs.claimStage(env.DB, runId, "drafting_topics", 300000);
  if (!owner) throw new StageBusyError(Math.max(1, Math.ceil((run.lease_until - Date.now()) / 1000) + 1));
  try {
    const saved = await getRecovery(env, runId);
    if (saved && saved.stage !== "ingest") return;
    const campaign = await campaigns.get(env.DB, run.campaign_id);
    if (!campaign) throw new Error(`campaign ${run.campaign_id} not found`);
    const complete = await ingestSources(env, campaign, runId);
    await advanceResearch(env, runId, "ingest", complete ? "assess" : "ingest", owner);
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}

/** Stop missing evidence before topic research, writing and revision spend. */
export async function stageAssess(env: Env, runId: string): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run || run.state !== "drafting_topics") return;
  const owner = await runs.claimStage(env.DB, runId, "drafting_topics", 120000);
  if (!owner) throw new StageBusyError(Math.max(1, Math.ceil((run.lease_until - Date.now()) / 1000) + 1));
  try {
    const saved = await getRecovery(env, runId);
    if (saved && saved.stage !== "assess") return;
    const campaign = await campaigns.get(env.DB, run.campaign_id);
    if (!campaign) throw new Error("The brief for this run is missing.");
    const report = await assessReadiness(env, campaign, runId);
    if (report.state === "needs_input") {
      await runs.handOff(env.DB, runId, "drafting_topics", "needs_input", owner);
      return;
    }
    await advanceResearch(env, runId, "assess", report.state === "ready" ? "topics" : "assess", owner);
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}

// Stage leases: TTL long enough for the whole stage's provider work; a crashed
// isolate's lease self-expires so a later retry can reclaim.
const TOPICS_LEASE_MS = 240_000;
const WRITE_LEASE_MS = 300_000;

/** Stage: grounded topic proposal via Anthropic web search. */
export async function stageTopics(env: Env, runId: string): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  // Idempotency: only run while still drafting; a replay after selection skips.
  if (run.state !== "drafting_topics") return;
  // Exclusive claim so two at-least-once deliveries can't both call Anthropic.
  const owner = await runs.claimStage(env.DB, runId, "drafting_topics", TOPICS_LEASE_MS);
  if (!owner) throw new StageBusyError(Math.max(1, Math.ceil((run.lease_until - Date.now()) / 1000) + 1));
  try {
    const campaign = await campaigns.get(env.DB, run.campaign_id);
    if (!campaign) throw new Error(`campaign ${run.campaign_id} not found`);

    const grounding = await groundingForRun(env, campaign, runId);
    const readiness = await loadReadiness(env, runId);
    // Generate first, then atomically swap in the new topics (old set survives
    // a failed proposal — never delete-before-success). Research is oriented by
    // the campaign's article type (comparison = research the contenders, etc).
    await generateTopicsForRun(
      env,
      campaign.id,
      runId,
      campaign.idea,
      grounding,
      `${articleTypeByValue(campaign.article_type).research}\n${acceptedGapsGuidance(readiness?.acceptance ? readiness.gaps : undefined)}\nDestinations: ${selectedChannels(campaign.output_format, campaign.output_formats).map((format) => `${format}: ${channelProfile(format).summary}`).join("; ")}. For email and chat propose one focused message that fits the channel; for LinkedIn propose one professional insight. Channel suitability takes priority over SEO framing.`,
    );

    // Human picks next; no auto-advance past selection.
    await runs.handOff(env.DB, runId, "drafting_topics", "awaiting_topic_selection", owner);
  } finally {
    await runs.releaseStage(env.DB, runId, owner);
  }
}

/** Stage: agentic write + deterministic house-style pass. */
export async function stageWrite(env: Env, runId: string): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  // Idempotency: only run in 'writing'. A replay after completion skips.
  if (run.state === "styling") {
    if ((await getRecovery(env, runId))?.stage !== "review") await enqueue(env, { runId, stage: "review" });
    return;
  }
  if (run.state !== "writing") return;
  // Exclusive claim so duplicate delivery can't run the expensive write twice.
  const owner = await runs.claimStage(env.DB, runId, "writing", WRITE_LEASE_MS);
  if (!owner) throw new StageBusyError(Math.max(1, Math.ceil((run.lease_until - Date.now()) / 1000) + 1));
  try {
    const campaign = await campaigns.get(env.DB, run.campaign_id);
    if (!campaign) throw new Error(`campaign ${run.campaign_id} not found`);

    const selected = await topicsRepo.selectedForRun(env.DB, runId);
    if (selected.length === 0) throw new Error("no topic selected for run");

    const evidence = await groundingEvidenceForRun(env, campaign, runId);
    const readiness = await loadReadiness(env, runId);
    const grounding = evidence.text;
    const voice = voiceInstruction(campaign.voice_profile);
    const persona = optionInstruction(PERSONAS, campaign.persona);
    const tone = optionInstruction(TONES, campaign.tone);
    const temperature = clampTemperature(campaign.temperature);
    // Campaign-level enrichment: reference links woven in + a CTA block whose
    // button links to its own configured action (website/email/whatsapp/call).
    const referenceLinks = readReferenceLinks(campaign.reference_links);
    const ctaPreset = ctaByValue(campaign.cta);
    const cta = ctaPreset
      ? { preset: ctaPreset, href: buildCtaHref(campaign.cta_action, campaign.cta_target) }
      : null;

    // Output-format gate: the platform picked at topic selection, bound to THIS
    // run (H-01). It shapes how social posts are WRITTEN (short, no tables) and
    // how every article's body is RENDERED (html/word stay rich; markdown/plain/
    // social serialize the HTML).
    const formats = selectedChannels(run.output_format, run.output_formats);

    // The user's prior articles, for near-duplicate flagging (not blocking).
    const priors: PriorArticle[] = (
      await articlesRepo.priorForUser(env.DB, campaign.user_id, runId)
    ).map((p) => ({ title: p.title, signature: articleSignature(p.title, p.body_html) }));

    // Build all articles in memory first, then swap atomically, so a failed
    // retry never deletes completed articles before replacements are ready.
    const built: ArticleInsert[] = [];
    const checkpoints: EditorialCheckpoint[] = [];
    for (const outputFormat of formats) for (const topic of selected) {
      const effWords = Math.min(campaign.max_words, channelProfile(outputFormat).maxWords);
      const formatGuidance = formatWriterGuidance(outputFormat);
      const progressId = formats.length > 1 ? `${topic.id}:${outputFormat}` : topic.id;
      const reserve = enrichmentReserveWords(referenceLinks, cta, isCampaignChannel(outputFormat)) + countWords(campaign.signature);
      if (effWords - reserve < (outputFormat === "chat" ? 30 : 80)) throw new Error("The links, call to action and signature leave too little space. Increase the word limit or shorten them.");
      const input = {
        originalBrief: campaign.idea,
        ...(readiness?.acceptance ? { acceptedEvidenceGaps: readiness.gaps.map(({ requirement, missing }) => ({ requirement, missing })) } : {}),
        topicTitle: topic.title,
        angle: topic.angle,
        primaryKw: topic.primary_kw,
        voiceProfileInstruction: voice,
        personaInstruction: persona,
        toneInstruction: tone,
        temperature,
        maxWords: effWords - reserve,
        groundingText: grounding,
        groundingSources: evidence.sources,
        includeIdeas: campaign.include_ideas,
        excludeIdeas: campaign.exclude_ideas,
        biasLevel: campaign.bias_level,
        articleTypeInstruction: articleTypeByValue(campaign.article_type).writing,
        formatGuidance,
        outputFormat,
        progressKey: { runId, topicId: progressId },
      };
      let generated;
      try { generated = await generateArticle(env, input); }
      catch (error) {
        if (!(error instanceof DraftPendingError)) throw error;
        await runs.releaseStage(env.DB, runId, owner);
        try { await enqueue(env, { runId, stage: "write" }); }
        catch { throw new RetryableError("Could not resume article writing"); }
        return;
      }
      // Yield between completed channels; cached drafts never buy another writing call.
      if (formats.length > 1 && outputFormat !== formats.at(-1) && !await articleProgress.load(env.DB, runId, `${progressId}:complete`)) {
        await articleProgress.save(env.DB, runId, `${progressId}:complete`, "{}", "{}");
        await runs.releaseStage(env.DB, runId, owner);
        await enqueue(env, { runId, stage: "write" });
        return;
      }
      const checkpoint: EditorialCheckpoint = { version: 1, state: "review", revision: 0,
        model: env.ANTHROPIC_MODEL, input, core: generated, finalMaxWords: effWords,
        referenceLinks, cta, signature: campaign.signature, report: null };
      checkpoints.push(checkpoint);
      const normalized = await prepareArticle(generated, checkpoint);
      const keyPhrases = normalized.key_phrases;
      const finalBody = normalized.body_html;

      // Flag (never block) a near-duplicate of one of the user's prior articles.
      const match = mostSimilar(articleSignature(normalized.title, finalBody), priors);
      const flagged = match && match.score >= SIMILAR_THRESHOLD ? match : null;
      if (flagged) logEvent("article.similar", { score: flagged.score });

      // Render the canonical HTML into the chosen output format. Rich formats
      // (html/word) keep body_html and leave output_body empty; text formats store
      // the serialized body for display/copy/download.
      const outputBody = isRichFormat(outputFormat)
        ? ""
        : renderOutput(finalBody, outputFormat, {
            keyPhrases,
            title: normalized.title,
            maxWords: Number.MAX_SAFE_INTEGER,
          }).body;

      built.push({
        run_id: runId,
        title: normalized.title,
        body_html: finalBody,
        excerpt: normalized.excerpt,
        slug: normalized.slug,
        meta_desc: normalized.meta_desc,
        key_phrases: JSON.stringify(keyPhrases),
        png_r2_key: null,
        similar_to: flagged ? flagged.title : "",
        similar_score: flagged ? flagged.score : 0,
        output_format: outputFormat,
        output_body: outputBody,
      });
    }

    const drafts = await articlesRepo.replaceForRun(env.DB, runId, built);
    for (const [index, draft] of drafts.entries()) {
      const checkpoint = checkpoints[index];
      if (!checkpoint) throw new Error("Draft review checkpoint is missing");
      await saveEditorial(env, draft.id, checkpoint);
    }
    if (!await runs.handOff(env.DB, runId, "writing", "styling", owner)) return;
    await articleProgress.clearForRun(env.DB, runId).catch(() => logEvent("write.cleanup_deferred", { run_id: runId }));
    try { await enqueue(env, { runId, stage: "review" }); }
    catch { throw new RetryableError("Could not schedule editorial review"); }
  } finally {
    await runs.releaseStage(env.DB, runId, owner);
  }
}

/**
 * Stage: plan a grounded infographic with the text model and render it with OpenAI,
 * seeded by the canonical article plus the campaign's optional visual direction.
 * Best-effort: if image generation fails, the run still completes without a
 * featured image (the article and its copy fields are the core deliverable).
 */
export async function stageImage(env: Env, runId: string, attempt = 1): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  // Idempotency: only run in 'asset_gen'. A replay after ready skips.
  if (run.state !== "asset_gen") return;
  const lease = await runs.claimStage(env.DB, runId, "asset_gen", 300_000);
  if (!lease) throw new StageBusyError(Math.max(1, Math.ceil((run.lease_until - Date.now()) / 1000) + 1));
  try {
    const list = await articlesRepo.listForRun(env.DB, runId);
    if (list.length === 0) throw new Error("no articles for image stage");

    const campaign = await campaigns.get(env.DB, run.campaign_id);
    for (const article of list) {
      // Retry only incomplete assets; queue replays do not buy another image.
      if (article.png_r2_key || (await imageJobs.get(env.DB, article.id))?.state === "failed") continue;
      const pngKey = `articles/${article.id}/featured.png`;
      try {
        const key = await renderFeaturedVisual(env, article, campaign, {
          pngKey, briefKey: `articles/${article.id}/image-brief.json`,
        });
        await articlesRepo.update(env.DB, article.id, { png_r2_key: key });
      } catch (e) {
        if (e instanceof RetryableError && attempt < 3) throw e;
        // Provider messages are sanitised by the clients; no prompts or source
        // content are logged. Permanent/final failures preserve the article.
        console.error(`image generation failed for ${article.id}: ${String(e)}`);
        // Persist the failure before yielding; otherwise a replay could buy it again.
        await imageJobs.initialFailure(env.DB, article.id, imageFailureMessage(e));
      }
      // One visual per delivery, so several channels do not share a long lease.
      if (list.length > 1) {
        await runs.releaseStage(env.DB, runId, lease);
        await enqueue(env, { runId, stage: "image" });
        return;
      }
    }

    // Precompute bundles so downloads stream bytes rather than zip per click.
    const finalArticles = await articlesRepo.listForRun(env.DB, runId);
    for (const article of finalArticles) {
      try {
        const zip = await buildBundle(env, article);
        const bundleKey = `articles/${article.id}/bundle.zip`;
        await env.ASSETS.put(bundleKey, zip, {
          httpMetadata: { contentType: "application/zip" },
        });
        await articlesRepo.update(env.DB, article.id, { bundle_r2_key: bundleKey });
      } catch (e) {
        console.error(`bundle build failed for ${article.id}: ${String(e)}`);
      }
    }

    if (!await runs.handOff(env.DB, runId, "asset_gen", "ready", lease)) return;
    await enqueue(env, { runId, stage: "ready" });
  } finally {
    await runs.releaseStage(env.DB, runId, lease);
  }
}

/** Stage: optional ready notification. */
export async function stageReady(env: Env, runId: string): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const campaign = await campaigns.get(env.DB, run.campaign_id);
  if (!campaign) return;
  const owner = await users.get(env.DB, campaign.user_id);
  const list = await articlesRepo.listForRun(env.DB, runId);
  const first = list[0];
  if (!owner || !first) return;

  const base = env.APP_BASE_URL ?? "";
  // Notification is non-critical: a delivery failure must NOT fail a ready run.
  try {
    await sendReadyEmail(env, {
      to: owner.email,
      articleTitle: first.title,
      resultUrl: `${base}/runs/${runId}`,
    });
  } catch (e) {
    console.error(`ready email failed for ${runId} (run stays ready): ${String(e)}`);
  }
}

/** Kick a run: enqueue the first stage. */
export async function startRun(env: Env, runId: string): Promise<void> {
  await runs.setState(env.DB, runId, "drafting_topics");
  await enqueue(env, { runId, stage: "ingest" });
}

/** Resume after human topic selection. */
export async function resumeWriting(env: Env, runId: string): Promise<void> {
  await runs.setState(env.DB, runId, "writing");
  await enqueue(env, { runId, stage: "write" });
}

/**
 * Enqueue the write stage without setting state — the caller has already claimed
 * the transition into "writing" via a compare-and-set, so we only kick the queue.
 */
export async function enqueueWrite(env: Env, runId: string): Promise<void> {
  await enqueue(env, { runId, stage: "write" });
}

/**
 * Re-run topic proposal in place (the "regenerate 3 titles" action). The caller
 * has already transitioned the run back to 'drafting_topics'; this just kicks
 * the topics stage, which replaces the current topics and re-awaits selection.
 */
export async function resumeTopics(env: Env, runId: string): Promise<void> {
  await enqueue(env, { runId, stage: "topics" });
}

/** Enqueue an off-request bundle rebuild for one article (after an inline edit). */
export async function enqueueBundle(
  env: Env,
  runId: string,
  articleId: string,
): Promise<void> {
  await enqueue(env, { runId, stage: "bundle", articleId });
}

/** Rebuild + store the download bundle for a single article. Best-effort. */
export async function rebuildArticleBundle(
  env: Env,
  article: Article,
): Promise<void> {
  const zip = await buildBundle(env, article);
  const bundleKey = article.bundle_r2_key || `articles/${article.id}/bundle.zip`;
  await env.ASSETS.put(bundleKey, zip, {
    httpMetadata: { contentType: "application/zip" },
  });
  if (!article.bundle_r2_key) {
    await articlesRepo.update(env.DB, article.id, { bundle_r2_key: bundleKey });
  }
}

/** Stage: rebuild one article's bundle off the HTTP path (idempotent, replayable). */
export async function stageBundle(
  env: Env,
  runId: string,
  articleId?: string,
): Promise<void> {
  if (!articleId) return;
  const article = await articlesRepo.get(env.DB, articleId);
  if (!article || article.run_id !== runId) return;
  await rebuildArticleBundle(env, article);
}
