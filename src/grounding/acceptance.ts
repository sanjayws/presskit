import type { Env } from "../env";
import { campaigns, runs, type Campaign } from "../db/repos";
import { loadReadiness, readinessKey, type ReadinessReport } from "./readiness";
import { loadSourceReport } from "./report";
import { sha256Hex } from "./ingest";
import { restartStage } from "../pipeline/recovery";

/** Keep acceptance stable across a retry, but invalidate it when the brief/findings change. */
export function readinessAcceptanceToken(report: ReadinessReport, campaign: Campaign): Promise<string> {
  return sha256Hex(JSON.stringify({ campaign, report: { version: report.version, fingerprint: report.fingerprint,
    state: report.state, summary: report.summary, gaps: report.gaps, checkedAt: report.checkedAt } }));
}

/** No provider calls. Preserve the failed assessment and record the owner's exception. */
export async function acceptReadiness(env: Env, runId: string, userId: string, token: string): Promise<boolean> {
  const run = await runs.getForUser(env.DB, runId, userId);
  if (!run || run.state !== "needs_input" || !token) return false;
  const owner = await runs.claimStage(env.DB, runId, "needs_input", 60000);
  if (!owner) return false;
  try {
    const report = await loadReadiness(env, runId);
    const campaign = await campaigns.get(env.DB, run.campaign_id);
    if (!report || report.state !== "needs_input" || !campaign || token !== await readinessAcceptanceToken(report, campaign)) return false;
    if (!(await loadSourceReport(env, runId)).some((source) => source.status === "loaded")) return false;
    report.acceptance = { userId, at: new Date().toISOString(), token };
    await env.ASSETS.put(readinessKey(runId), JSON.stringify(report), { httpMetadata: { contentType: "application/json" } });
    return await restartStage(env, runId, "needs_input", "topics", owner);
  } finally { await runs.releaseStage(env.DB, runId, owner); }
}
