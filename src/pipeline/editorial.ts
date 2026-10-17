/** One editor/revision call per queue message; a checkpoint precedes every hand-off. */
import { acceptanceSnapshot, reviewFingerprint } from "../editorial/acceptance";
import type { Env } from "../env";
import { articles, campaigns, runs } from "../db/repos";
import { loadEditorial, MAX_REVISIONS, reviewArticle, reviseArticle, saveEditorial } from "../editorial/review";
import { prepareArticle } from "../content/finalize";
import { isRichFormat, renderOutput } from "../content/render";
import { isOutputFormat } from "../style/engine";
import { RetryableError, StageBusyError } from "../errors";
import { logEvent } from "../log";
import { scheduleStage, getRecovery, restartStage } from "./recovery";
import { groundingEvidenceForRun } from "../grounding/report";

/** No provider calls: preserve findings and durably resume only after explicit acceptance. */
export async function acceptSavedDraft(env: Env, runId: string, userId: string, snapshot: string): Promise<boolean> {
  if (!snapshot || !(await runs.getForUser(env.DB, runId, userId))) return false;
  const owner = await runs.claimStage(env.DB, runId, "failed", 60000);
  if (!owner) return false;
  try {
    const list = await articles.listForRun(env.DB, runId);
    const saved = await Promise.all(list.map(async (article) => ({ article, checkpoint: await loadEditorial(env, article.id) })));
    if (await acceptanceSnapshot(saved) !== snapshot) return false;
    for (const { article, checkpoint } of saved) {
      if (!checkpoint || checkpoint.state === "passed") continue;
      checkpoint.acceptance = { userId, at: new Date().toISOString(), fingerprint: await reviewFingerprint(article, checkpoint) };
      checkpoint.state = "accepted";
      await saveEditorial(env, article.id, checkpoint);
    }
    return await restartStage(env, runId, "failed", "review", owner);
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}

/** User-requested recheck preserves the draft and starts a fresh bounded review. */
export async function recheckSavedDraft(env: Env, runId: string): Promise<boolean> {
  const owner = await runs.claimStage(env.DB, runId, "failed", 60000);
  if (!owner) return false;
  try {
    const list = await articles.listForRun(env.DB, runId);
    const saved = await Promise.all(list.map(async (article) => ({ article, checkpoint: await loadEditorial(env, article.id) })));
    if (!saved.length || saved.some((item) => !item.checkpoint) || !saved.some(({ checkpoint }) => checkpoint?.state === "needs_attention"
      || checkpoint?.state === "review" && checkpoint.revision === 0 && checkpoint.report !== null)) return false;
    for (const { article, checkpoint } of saved) {
      if (!checkpoint || checkpoint.state !== "needs_attention") continue;
      checkpoint.state = "review";
      checkpoint.revision = 0;
      await saveEditorial(env, article.id, checkpoint);
    }
    return await restartStage(env, runId, "failed", "review", owner);
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}

export async function stageEditorial(env: Env, runId: string): Promise<void> {
  const run = await runs.get(env.DB, runId);
  if (!run) return;
  // Recover a crash between the state transition and its queue hand-off.
  if (run.state === "asset_gen") {
    if ((await getRecovery(env, runId))?.stage !== "image") await scheduleStage(env, { runId, stage: "image" });
    return;
  }
  if (run.state !== "styling") return;
  const owner = await runs.claimStage(env.DB, runId, "styling", 180000);
  if (!owner) throw new StageBusyError(Math.max(1, Math.ceil((run.lease_until - Date.now()) / 1000) + 1));
  try {
    const list = await articles.listForRun(env.DB, runId);
    if (!list.length) throw new Error("No draft is available for editorial review");
    for (const article of list) {
      const checkpoint = await loadEditorial(env, article.id);
      if (!checkpoint) throw new Error("The editorial checkpoint is missing. Reopen the brief to start a new run.");
      if (checkpoint.state === "needs_attention") continue;
      if (checkpoint.state === "passed") continue;
      if (checkpoint.state === "accepted") {
        if (!checkpoint.acceptance || checkpoint.acceptance.fingerprint !== await reviewFingerprint(article, checkpoint)) {
          throw new Error("The saved draft changed after exceptions were accepted. Reopen the draft for review.");
        }
        continue;
      }
      if (!checkpoint.input.groundingSources) {
        const campaign = await campaigns.get(env.DB, run.campaign_id);
        if (!campaign) throw new Error("The campaign for this saved draft is missing");
        const evidence = await groundingEvidenceForRun(env, campaign, runId);
        checkpoint.input.groundingSources = evidence.sources;
        checkpoint.input.groundingText = evidence.text;
        await saveEditorial(env, article.id, checkpoint);
      }
      checkpoint.model = env.ANTHROPIC_MODEL;
      if (checkpoint.state === "revise") {
        checkpoint.core = await reviseArticle(env, checkpoint);
        checkpoint.revision++;
        checkpoint.state = "review";
        await saveEditorial(env, article.id, checkpoint);
      } else {
        const candidate = await prepareArticle(checkpoint.core, checkpoint);
        const format = isOutputFormat(article.output_format) ? article.output_format : "html";
        await articles.update(env.DB, article.id, { ...candidate, key_phrases: JSON.stringify(candidate.key_phrases),
          output_body: isRichFormat(format) ? "" : renderOutput(candidate.body_html, format, { keyPhrases: candidate.key_phrases, title: candidate.title, maxWords: Number.MAX_SAFE_INTEGER }).body });
        checkpoint.report = await reviewArticle(env, candidate, checkpoint);
        checkpoint.state = checkpoint.report.passed ? "passed" : checkpoint.revision >= MAX_REVISIONS ? "needs_attention" : "revise";
        await saveEditorial(env, article.id, checkpoint);
        logEvent("article.review", { run_id: runId, article_id: article.id, revision: checkpoint.revision, passed: checkpoint.report.passed, issue_count: checkpoint.report.issues.length });
      }
      // New messages have their own infrastructure retry budget; successful
      // editorial revisions are bounded by the persisted revision counter.
      if (checkpoint.state === "needs_attention" && list.length === 1) {
        await runs.fail(env.DB, runId, "Editorial review needs attention. Review the findings and update the brief or sources.");
      } else {
        await runs.releaseStage(env.DB, runId, owner);
        try { await scheduleStage(env, { runId, stage: "review" }); }
        catch { throw new RetryableError("Could not schedule the next editorial step"); }
      }
      return;
    }
    for (const article of list) {
      if ((await loadEditorial(env, article.id))?.state === "needs_attention") {
        await runs.fail(env.DB, runId, "Editorial review needs attention. Review the findings and accept exceptions or request a recheck.");
        return;
      }
    }
    if (!await runs.handOff(env.DB, runId, "styling", "asset_gen", owner)) return;
    try { await scheduleStage(env, { runId, stage: "image" }); }
    catch {
      // State already advanced atomically. The watchdog repairs this hand-off;
      // never rewind a stage which another delivery may already have claimed.
      throw new RetryableError("Could not schedule the featured visual");
    }
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}
