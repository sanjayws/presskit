/** Image-only jobs leave the article run ready and preserve the last good image. */
import type { Env } from "../env";
import { articles, campaigns, runs } from "../db/repos";
import { imageJobs } from "../db/image-jobs";
import { articleImageBriefKey, imageJobPrefix } from "../images/assets";
import { renderFeaturedVisual } from "../images/render";
import { imageFailureMessage } from "../images/errors";
import { recordOf } from "../providers/http";
import { sha256Hex } from "../grounding/ingest";
import { RetryableError } from "../errors";
import { logEvent } from "../log";
import { rebuildArticleBundle } from "./run";

export class ImageJobBusyError extends RetryableError {
  constructor(public readonly delaySeconds: number) { super("Image job is already being processed"); }
}

export async function stageImageJob(env: Env, runId: string, articleId?: string, jobId?: string, attempt = 1): Promise<void> {
  if (!articleId || !jobId) return;
  const job = await imageJobs.get(env.DB, articleId);
  if (!job || job.id !== jobId || job.state === "ready" || job.state === "failed") return;
  const article = await articles.get(env.DB, articleId);
  const run = await runs.get(env.DB, runId);
  if (!article || article.run_id !== runId || !run || run.state !== "ready") return;
  const owner = await imageJobs.claim(env.DB, articleId, jobId);
  if (!owner) throw new ImageJobBusyError(Math.max(1, Math.ceil((job.lease_until - Date.now()) / 1000) + 1));
  const prefix = imageJobPrefix(articleId, jobId);
  try {
    const campaign = await campaigns.get(env.DB, run.campaign_id);
    const pngKey = await renderFeaturedVisual(env, article, campaign, {
      pngKey: `${prefix}/featured.png`, briefKey: `${prefix}/image-brief.json`,
      sourceBriefKeys: job.mode === "retry" ? [job.source_brief_key, articleImageBriefKey(article)].filter((key): key is string => Boolean(key)) : [],
      previousBriefKey: job.mode === "new" ? articleImageBriefKey(article) : undefined,
    });
    const brief = await env.ASSETS.get(`${prefix}/image-brief.json`);
    const snapshot = brief && brief.size <= 32_000 ? recordOf(await brief.json<unknown>()) : {};
    if (snapshot.articleHash !== await sha256Hex(JSON.stringify([article.title, article.body_html]))) {
      await imageJobs.finish(env.DB, articleId, jobId, "failed", "The article changed while this visual was being created. Save your edits, then Generate New.");
      return;
    }
    // CAS prevents a concurrent saved edit from being paired with a stale image.
    const changed = await articles.attachImageIfUnchanged(env.DB, article, pngKey);
    if (!changed) {
      await imageJobs.finish(env.DB, articleId, jobId, "failed", "The article changed while this visual was being created. Save your edits, then Generate New.");
      return;
    }
    const latest = await articles.get(env.DB, articleId);
    if (latest) {
      try { await rebuildArticleBundle(env, latest); }
      catch { logEvent("image.bundle_rebuild_failed", { article_id: articleId, job_id: jobId }); }
    }
    await imageJobs.finish(env.DB, articleId, jobId, "ready");
    logEvent("image.job_ready", { article_id: articleId, job_id: jobId, mode: job.mode });
  } catch (error) {
    // Persist only fixed messages, not arbitrary provider or source text.
    if (error instanceof RetryableError && attempt < 3) throw error;
    await imageJobs.finish(env.DB, articleId, jobId, "failed", imageFailureMessage(error));
    logEvent("image.job_failed", { article_id: articleId, job_id: jobId, attempt });
  } finally {
    await imageJobs.release(env.DB, articleId, jobId, owner);
  }
}
