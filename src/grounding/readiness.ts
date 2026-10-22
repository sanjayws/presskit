import { selectedChannels } from "../style/channels";
import type { Env } from "../env";
import type { Campaign } from "../db/repos";
import { groundingEvidenceForRun, loadSourceReport } from "./report";
import { sha256Hex } from "./ingest";
import { channelProfile } from "../style/engine";
import { decideReadiness, explainReadiness, type ReadinessGap } from "../openai/readiness";

export interface ReadinessReport {
  version: 1;
  fingerprint: string;
  state: "checking" | "ready" | "needs_input";
  summary: string;
  gaps: ReadinessGap[];
  checkedAt: number;
  acceptance?: { userId: string; at: string; token: string };
}
export const readinessKey = (runId: string) => `runs/${runId}/readiness.json`;
export async function loadReadiness(env: Env, runId: string): Promise<ReadinessReport | null> {
  const object = await env.ASSETS.get(readinessKey(runId));
  if (!object || object.size > 64000) return null;
  let value: ReadinessReport;
  try { value = await object.json<ReadinessReport>(); } catch { return null; }
  const bounded = (text: unknown) => typeof text === "string" && text.length > 0 && text.length <= 1200;
  if (!value || value.version !== 1 || !["checking", "ready", "needs_input"].includes(value.state)
    || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !bounded(value.summary) || !Number.isFinite(value.checkedAt) || !Array.isArray(value.gaps)
    || value.gaps.length > 6 || (value.state === "needs_input" ? !value.gaps.length : value.gaps.length !== 0)
    || value.gaps.some((gap) => !gap || !bounded(gap.requirement) || !bounded(gap.missing) || !bounded(gap.action))) return null;
  if (value.acceptance && (value.state !== "needs_input" || typeof value.acceptance.userId !== "string"
    || typeof value.acceptance.at !== "string" || !Number.isFinite(Date.parse(value.acceptance.at))
    || typeof value.acceptance.token !== "string" || !/^[a-f0-9]{64}$/.test(value.acceptance.token))) return null;
  return value;
}

/** One provider request per delivery; checkpoint before any next-stage hand-off. */
export async function assessReadiness(env: Env, campaign: Campaign, runId: string): Promise<ReadinessReport> {
  const sources = await loadSourceReport(env, runId);
  const evidence = sources.some((source) => source.status === "loaded") ? await groundingEvidenceForRun(env, campaign, runId) : null;
  const input = JSON.stringify({ brief: campaign.idea, mustCover: campaign.include_ideas, avoid: campaign.exclude_ideas,
    writingMode: campaign.article_type,
    destinations: selectedChannels(campaign.output_format, campaign.output_formats).map((format) => ({ destination: format, channel: channelProfile(format).summary, maxWords: Math.min(campaign.max_words, channelProfile(format).maxWords) })),
    maxWords: Math.min(campaign.max_words, channelProfile(campaign.output_format).maxWords),
    sources, evidence: evidence?.sources ?? [],
  });
  const fingerprint = await sha256Hex(`readiness-v1\n${input}`);
  const previous = await loadReadiness(env, runId);
  if (previous?.fingerprint === fingerprint && previous.state !== "checking") return previous;
  let report: ReadinessReport;
  if (!evidence && campaign.article_type === "fiction") {
    report = { version: 1, fingerprint, state: "ready", summary: "Your fictional premise is ready. Invented narrative events will be identified as fiction; real-world claims still require evidence.", gaps: [], checkedAt: Date.now() };
  } else if (!evidence) {
    report = { version: 1, fingerprint, state: "needs_input", summary: "None of the supplied sources could be read. Writing has not started.",
      gaps: [{ requirement: campaign.idea.slice(0, 1200), missing: "There is no readable source material to support this brief.",
        action: "Open the source details below. Upload a readable copy of the relevant pages, or replace blocked links with accessible sources, then check the brief again." }], checkedAt: Date.now() };
  } else if (previous?.fingerprint === fingerprint && previous.state === "checking") {
    const advice = await explainReadiness(env, input, `${campaign.idea}\n${campaign.include_ideas}`);
    report = { version: 1, fingerprint, state: advice.ready ? "ready" : "needs_input", summary: advice.summary, gaps: advice.gaps, checkedAt: Date.now() };
  } else {
    const decision = await decideReadiness(env, input);
    const ready = decision.choice === "ready";
    report = { version: 1, fingerprint, state: ready ? "ready" : "checking", summary: ready
      ? "Your readable sources support the brief. Presskit can now propose angles; the draft will still receive a separate factual and editorial review."
      : "Checking which requested details need clarification before writing.", gaps: [], checkedAt: Date.now() };
  }
  await env.ASSETS.put(readinessKey(runId), JSON.stringify(report), { httpMetadata: { contentType: "application/json" } });
  return report;
}
