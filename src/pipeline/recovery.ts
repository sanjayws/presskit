/** D1-backed delivery intent plus a scheduled watchdog for interrupted runs. */
import type { Env, PipelineMessage } from "../env";
import { runs, type RunState } from "../db/repos";
import { logEvent } from "../log";
import { loadSourceReport, sourceReportKey } from "../grounding/report";
import { readinessKey } from "../grounding/readiness";
import { resetFailedVisuals } from "../images/vision";
import { runImages } from "../images/uploads";

const WATCHDOG_MS = 10 * 60_000;
export const MAX_BACKGROUND_FAILURES = 12;
export const RECOVERABLE_STAGES = new Set(["ingest", "assess", "topics", "write", "style", "review", "image"]);
type Recovery = { run_id: string; stage: PipelineMessage["stage"]; due_at: number; failures: number; retrying: number };
export const getRecovery = (env: Env, runId: string) => env.DB.prepare("SELECT * FROM run_recovery WHERE run_id = ?").bind(runId).first<Recovery>();

/** Persist before send: a broken hand-off is recovered without a browser retry. */
export async function scheduleStage(env: Env, message: PipelineMessage): Promise<void> {
  if (!RECOVERABLE_STAGES.has(message.stage)) { await env.PIPELINE.send(message); return; }
  await env.DB.prepare(`INSERT INTO run_recovery(run_id, stage, due_at) VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET stage=excluded.stage, due_at=excluded.due_at, failures=0, retrying=0`)
    .bind(message.runId, message.stage, Date.now() + WATCHDOG_MS).run();
  try { await env.PIPELINE.send(message); }
  catch { logEvent("stage.handoff_saved", { run_id: message.runId, stage: message.stage }); }
}

/** Source stages share one run state: persist the next intent and release its
 * lease in one transaction so an old delivery cannot rewind the hand-off. */
export async function advanceResearch(env: Env, runId: string, from: "ingest" | "assess", next: "ingest" | "assess" | "topics", owner: string): Promise<void> {
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO run_recovery(run_id,stage,due_at)
      SELECT id,?,? FROM runs WHERE id=? AND state='drafting_topics' AND lease_owner=?
      ON CONFLICT(run_id) DO UPDATE SET stage=excluded.stage,due_at=excluded.due_at,failures=0,retrying=0
      WHERE run_recovery.stage=?`).bind(next, Date.now() + WATCHDOG_MS, runId, owner, from),
    env.DB.prepare(`UPDATE runs SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?
      AND EXISTS (SELECT 1 FROM run_recovery WHERE run_id=runs.id AND stage=?)`).bind(runId, owner, next),
  ]);
  if (!result[0]?.meta.changes) return;
  try { await env.PIPELINE.send({ runId, stage: next }); }
  catch { logEvent("stage.handoff_saved", { run_id: runId, stage: next }); }
}

/** Commit a user-requested restart and its recovery intent together. */
export async function restartStage(env: Env, runId: string, from: RunState, stage: PipelineMessage["stage"], owner: string): Promise<boolean> {
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO run_recovery(run_id,stage,due_at)
      SELECT id,?,? FROM runs WHERE id=? AND state=? AND lease_owner=?
      ON CONFLICT(run_id) DO UPDATE SET stage=excluded.stage,due_at=excluded.due_at,failures=0,retrying=0`)
      .bind(stage, Date.now() + WATCHDOG_MS, runId, from, owner),
    env.DB.prepare(`UPDATE runs SET state=?,error=NULL,lease_owner=NULL,lease_until=0
      WHERE id=? AND state=? AND lease_owner=?`).bind(stateForStage(stage), runId, from, owner),
  ]);
  if (!result[1]?.meta.changes) return false;
  try { await env.PIPELINE.send({ runId, stage }); }
  catch { logEvent("stage.handoff_saved", { run_id: runId, stage }); }
  return true;
}

/** A provider timeout does not make a durable run terminal. Back off up to an hour. */
export async function retryInBackground(env: Env, message: PipelineMessage, reason = ""): Promise<void> {
  const current = await getRecovery(env, message.runId);
  const failures = (current?.stage === message.stage ? current.failures : 0) + 1;
  if (current && current.stage !== message.stage) return; // A newer stage already owns recovery.
  if (failures > (message.stage === "assess" ? 2 : MAX_BACKGROUND_FAILURES)) {
    await env.DB.prepare(`UPDATE runs SET state='failed',error=? WHERE id=? AND state=?
      AND EXISTS (SELECT 1 FROM run_recovery WHERE run_id=runs.id AND stage=?)`)
      .bind(`[${message.stage}] ${reason ? reason.slice(0, 1000) : "The service is still unavailable after repeated attempts."} Background retries exhausted. Your work is saved.`, message.runId, stateForStage(message.stage), message.stage).run();
    logEvent("stage.retry_limit", { run_id: message.runId, stage: message.stage, failures });
    return;
  }
  const delay = [30, 120, 300, 900, 1800, 3600][Math.min(failures - 1, 5)]!;
  const saved = await env.DB.prepare(`INSERT INTO run_recovery(run_id, stage, due_at, failures, retrying) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(run_id) DO UPDATE SET due_at=excluded.due_at, failures=excluded.failures, retrying=1 WHERE run_recovery.stage=excluded.stage`)
    .bind(message.runId, message.stage, Date.now() + delay * 1000 + WATCHDOG_MS, failures).run();
  if (!saved.meta.changes) return;
  try { await env.PIPELINE.send(message, { delaySeconds: delay }); }
  catch {
    await env.DB.prepare("UPDATE run_recovery SET due_at=? WHERE run_id=? AND stage=?")
      .bind(Date.now() + delay * 1000, message.runId, message.stage).run();
  }
  logEvent("stage.background_retry", { run_id: message.runId, stage: message.stage, failures, delay_seconds: delay });
}

export function stateForStage(stage: PipelineMessage["stage"]): RunState {
  return stage === "ingest" || stage === "assess" || stage === "topics" ? "drafting_topics" : stage === "review" ? "styling" : stage === "image" ? "asset_gen" : "writing";
}
function stageForState(state: RunState, saved: PipelineMessage["stage"]): PipelineMessage["stage"] {
  return state === "drafting_topics" ? saved === "topics" || saved === "assess" ? saved : "ingest"
    : state === "writing" ? "write" : state === "styling" ? "review" : "image";
}

/** Runs every five minutes. Live leases and human selection gates are excluded. */
export async function recoverStalledRuns(env: Env): Promise<void> {
  const now = Date.now();
  // Also adopt pre-migration active runs, never failed or completed runs.
  await env.DB.prepare(`INSERT OR IGNORE INTO run_recovery(run_id, stage, due_at)
    SELECT id, CASE state WHEN 'drafting_topics' THEN 'ingest' WHEN 'writing' THEN 'write' WHEN 'styling' THEN 'review' ELSE 'image' END, ?
    FROM runs WHERE state IN ('drafting_topics','writing','styling','asset_gen')`).bind(now + WATCHDOG_MS).run();
  const rows = await env.DB.prepare(`SELECT q.*, r.state FROM run_recovery q JOIN runs r ON r.id=q.run_id
    WHERE q.due_at<=? AND r.state IN ('drafting_topics','writing','styling','asset_gen')
    AND (r.lease_owner IS NULL OR r.lease_until<?) ORDER BY q.due_at LIMIT 25`).bind(now, now).all<Recovery & { state: RunState }>();
  for (const item of rows.results) {
    const claimed = await env.DB.prepare("UPDATE run_recovery SET due_at=? WHERE run_id=? AND due_at=?")
      .bind(now + WATCHDOG_MS, item.run_id, item.due_at).run();
    if (!claimed.meta.changes) continue;
    try {
      await env.PIPELINE.send({ runId: item.run_id, stage: stageForState(item.state, item.stage) });
      logEvent("stage.recovered", { run_id: item.run_id, stage: item.stage });
    } catch {
      await env.DB.prepare("UPDATE run_recovery SET due_at=? WHERE run_id=? AND due_at=?")
        .bind(now + 60_000, item.run_id, now + WATCHDOG_MS).run();
    }
  }
}

export async function resumeSavedRun(env: Env, runId: string): Promise<boolean> {
  const recovery = await getRecovery(env, runId);
  if (!recovery || !RECOVERABLE_STAGES.has(recovery.stage)) return false;
  const run = await runs.get(env.DB, runId);
  if (!run || !["failed", "needs_input"].includes(run.state)) return false;
  const from = run.state;
  const stage = from === "needs_input" ? "ingest" : recovery.stage;
  const owner = await runs.claimStage(env.DB, runId, from, 60000);
  if (!owner) return false;
  try {
    if (stage === "ingest") {
      await resetFailedVisuals(env,runImages(run));
      // A deliberate retry rereads failed sources; successful evidence stays cached.
      const loaded = (await loadSourceReport(env, runId)).filter((source) => source.status === "loaded");
      await env.ASSETS.put(sourceReportKey(runId), JSON.stringify(loaded));
      await env.DB.prepare("UPDATE source_uploads SET state='pending',error=NULL WHERE campaign_id=? AND state='unavailable'")
        .bind(run.campaign_id).run();
      await env.ASSETS.delete(readinessKey(runId));
    }
    return await restartStage(env, runId, from, stage, owner);
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}
