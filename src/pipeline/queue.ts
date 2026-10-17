/**
 * Queue consumer. One stage per message, batch size 1. Dispatches to the stage
 * handler; on failure marks the run failed and acks (the state carries the error
 * for the UI). Retryable infrastructure errors are surfaced via msg.retry.
 */
import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env, PipelineMessage } from "../env";
import { runs } from "../db/repos";
import { isTransientFailure, StageBusyError } from "../errors";
import { logEvent } from "../log";
import { ImageJobBusyError, stageImageJob } from "./image-job";
import { stageEditorial } from "./editorial";
import { imageJobs } from "../db/image-jobs";
import { imageFailureMessage } from "../images/errors";
import { RECOVERABLE_STAGES, retryInBackground, stateForStage, getRecovery } from "./recovery";

const MAX_ATTEMPTS = 3;
import {
  stageBundle,
  stageAssess,
  stageIngest,
  stageImage,
  stageReady,
  stageTopics,
  stageWrite,
} from "./run";

async function dispatch(env: Env, msg: PipelineMessage, attempt: number): Promise<void> {
  switch (msg.stage) {
    case "ingest":
      return stageIngest(env, msg.runId);
    case "assess":
      return stageAssess(env, msg.runId);
    case "topics":
      return stageTopics(env, msg.runId);
    case "write":
    case "style": // style is folded into the write stage
      return stageWrite(env, msg.runId);
    case "review":
      return stageEditorial(env, msg.runId);
    case "image": {
      const saved = await getRecovery(env, msg.runId);
      return stageImage(env, msg.runId, saved?.stage === "image" ? saved.failures + 1 : 1);
    }
    case "image_refresh":
      return stageImageJob(env, msg.runId, msg.articleId, msg.imageJobId, attempt);
    case "ready":
      return stageReady(env, msg.runId);
    case "bundle":
      return stageBundle(env, msg.runId, msg.articleId);
    default:
      throw new Error(`unknown stage: ${(msg).stage}`);
  }
}

export async function handleQueue(
  batch: MessageBatch<PipelineMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;
    const startedAt = Date.now();
    try {
      // These stages share a run state. Late deliveries must not rewind a
      // newer source assessment or repeat topic generation.
      if (["ingest", "assess", "topics"].includes(msg.stage)) {
        const saved = await getRecovery(env, msg.runId);
        if (saved && saved.stage !== msg.stage) { message.ack(); continue; }
      }
      if (RECOVERABLE_STAGES.has(msg.stage)) {
        await env.DB.prepare("INSERT OR IGNORE INTO run_recovery(run_id,stage,due_at) SELECT id,?,? FROM runs WHERE id=?")
          .bind(msg.stage, Date.now() + 600000, msg.runId).run();
        await env.DB.prepare("UPDATE run_recovery SET due_at=? WHERE run_id=? AND stage=?")
          .bind(Date.now() + 600000, msg.runId, msg.stage).run();
      }
      await dispatch(env, msg, message.attempts);
      logEvent("stage.ok", {
        run_id: msg.runId,
        stage: msg.stage,
        attempt: message.attempts,
        ms: Date.now() - startedAt,
      });
      message.ack();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const transient = isTransientFailure(err);
      const ms = Date.now() - startedAt;

      // A crashed delivery's lease may still be alive. Wait for its expiry
      // instead of consuming all provider retries immediately or marking it failed.
      if (err instanceof ImageJobBusyError || err instanceof StageBusyError) {
        message.retry({ delaySeconds: Math.min(601, err.delaySeconds) });
        continue;
      }

      if (transient && RECOVERABLE_STAGES.has(msg.stage)) {
        try {
          const run = await runs.get(env.DB, msg.runId);
          if (run?.state === stateForStage(msg.stage)) await retryInBackground(env, msg, reason);
          message.ack();
        } catch { message.retry({ delaySeconds: 60 }); }
        continue;
      }

      // Transient fault with retries left: let Queues redeliver (then DLQ).
      if (transient && message.attempts < MAX_ATTEMPTS) {
        logEvent("stage.retry", {
          run_id: msg.runId,
          stage: msg.stage,
          attempt: message.attempts,
          ms,
          reason: reason.slice(0, 200),
        });
        message.retry();
        continue;
      }

      // Permanent, or retries exhausted: mark failed unless the run already
      // reached a terminal 'ready' state (never clobber a completed result).
      try {
        if (msg.stage === "image_refresh" && msg.articleId && msg.imageJobId) {
          const job = await imageJobs.get(env.DB, msg.articleId);
          if (job?.id === msg.imageJobId && job.state !== "ready") {
            await imageJobs.finish(env.DB, msg.articleId, msg.imageJobId, "failed", imageFailureMessage(err));
          }
        }
        const run = await runs.get(env.DB, msg.runId);
        if (run && run.state !== "ready") {
          if (RECOVERABLE_STAGES.has(msg.stage)) {
            await env.DB.prepare(`UPDATE runs SET state='failed',error=? WHERE id=? AND state=?
              AND EXISTS (SELECT 1 FROM run_recovery WHERE run_id=runs.id AND stage=?)`)
              .bind(`[${msg.stage}] ${reason}`, msg.runId, stateForStage(msg.stage), msg.stage).run();
          } else await runs.fail(env.DB, msg.runId, `[${msg.stage}] ${reason}`);
        }
      } catch {
        // ignore secondary failure
      }
      logEvent("stage.fail", {
        run_id: msg.runId,
        stage: msg.stage,
        attempt: message.attempts,
        ms,
        transient,
        reason: reason.slice(0, 200),
      });
      message.ack();
    }
  }
}
