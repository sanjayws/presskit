import type { Env } from "../env";
import type { Campaign } from "../db/repos";
import { campaigns, groundingDocs, runs } from "../db/repos";
import { loadVisual, visualSources } from "../images/vision";
import { runImages, imageTag } from "../images/uploads";
import { sourcePrompt } from "./evidence";
import { readReferenceLinks } from "../content/enrich";
import { ingestUrl, loadGroundingEvidence, sourceExcerpt } from "./ingest";
import type { GroundingEvidence } from "./evidence";
import { RetryableError, isTransientFailure } from "../errors";
import { extractNextUpload, sourceUploads } from "./uploads";

export interface SourceResult { source: string; status: "loaded" | "unavailable" | "pending"; message: string; docId?: string; imageId?: string; attempts?: number }
export const sourceReportKey = (runId: string) => `runs/${runId}/sources.json`;
export async function loadSourceReport(env: Env, runId: string): Promise<SourceResult[]> {
  const object = await env.ASSETS.get(sourceReportKey(runId));
  return object && object.size <= 100000 ? object.json<SourceResult[]>() : [];
}
export function sourceFailureGuidance(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/OPENAI_API_KEY|OpenAI.*(?:401|403)|Anthropic.*(?:401|403)/i.test(message)) return "The document service could not authenticate. Ask your administrator to check the AI key and model access, then retry this saved upload.";
  if (/OpenAI|Anthropic/.test(message) && /429|quota|billing/i.test(message)) return "The document service reached a usage limit. Ask your administrator to check billing or wait for the limit to reset, then retry the saved upload.";
  if (/verbatim|preserve.*document/i.test(message)) return "The document conversion changed or omitted text. Export the original as PDF, or upload its relevant content as plain text.";
  if (/invalid.*(?:header|legacy Office)|Office.*invalid/i.test(message)) return "This Office file has an invalid header. Export a new Word, Excel, PowerPoint or PDF copy.";
  if (/too little readable text|no usable text/i.test(message)) return "This document needs at least 40 readable characters. Upload a document with supporting content, rather than an empty or image-only text file.";
  if (/too long/i.test(message)) return "This document exceeds the 60,000-character extracted-text limit or could not fit completely. Upload only the relevant pages, slides or sheets.";
  if (/too long|too large|size cap|unreadable.*completely/i.test(message)) return "This document could not be read completely. Upload only the relevant pages, slides or sheets as a smaller file.";
  if (/403|401|browser|automated access/.test(message)) return "This site blocks automated access or requires sign-in. Upload a PDF or text copy you can access.";
  if (/404|410/.test(message)) return "The page is missing. Check the URL or upload a copy.";
  if (/Anthropic|OpenAI/.test(message)) return "The document service could not complete extraction. Retry the saved upload, or upload a readable text copy.";
  if (/content-type|PDF|size cap/.test(message)) return "This file could not be read completely. Use a smaller PDF, text or HTML document.";
  if (error instanceof RetryableError) return "The source timed out or was temporarily unavailable. Try it again or upload a copy.";
  return "No usable public text could be read. Check the URL or upload a PDF, text or HTML copy.";
}

export async function ingestSources(env: Env, campaign: Campaign, runId: string): Promise<boolean> {
  if (await extractNextUpload(env, campaign.id)) return false;
  const results: SourceResult[] = [];
  const previous = await loadSourceReport(env, runId);
  const urls = [...new Set([...campaigns.refs(campaign).filter((ref) => ref.kind === "url").map((ref) => ref.source), ...readReferenceLinks(campaign.reference_links).map((ref) => ref.url)])];
  let fetched = 0;
  for (const url of urls) {
    const cached = previous.find((item) => item.source === url);
    if (cached && cached.status !== "pending") { results.push(cached); continue; }
    // One source per delivery bounds slow PDF extraction and retries.
    if (fetched++ >= 1) break;
    let failure: unknown;
    try {
        const { doc } = await ingestUrl(env, campaign.id, url);
        results.push({ source: url, status: "loaded", message: "Read for this article.", docId: doc.id });
    } catch (error) {
      // Source fetches have a bounded retry policy, but storage outages must not
      // mark a readable source unavailable and silently remove its evidence.
      if (!(error instanceof RetryableError) && isTransientFailure(error)) throw error;
      failure = error;
    }
    if (failure instanceof RetryableError && (cached?.attempts ?? 0) < 2) {
      results.push({ source: url, status: "pending", attempts: (cached?.attempts ?? 0) + 1, message: "Temporarily unavailable; retrying in the background." });
      await env.ASSETS.put(sourceReportKey(runId), JSON.stringify([...results, ...previous.filter((item) => !results.some((r) => r.source === item.source))]));
      throw failure;
    }
    if (failure) results.push({ source: url, status: "unavailable", message: sourceFailureGuidance(failure) });
    await env.ASSETS.put(sourceReportKey(runId), JSON.stringify(results));
  }
  const uploads = (await groundingDocs.listForCampaign(env.DB, campaign.id)).filter((doc) => doc.kind === "upload");
  for (const doc of uploads) results.push({ source: doc.source, status: "loaded", message: "Supporting document.", docId: doc.id });
  for (const upload of await sourceUploads(env, campaign.id)) {
    if (upload.state === "unavailable") results.push({ source: upload.filename, status: "unavailable", message: upload.error || "Document unavailable." });
  }
  for (const image of runImages(await runs.get(env.DB,runId))) {
    const visual = await loadVisual(env,image);
    results.push({ source: `Image ${imageTag(image)} · ${image.filename}`, imageId: image.id, status: visual?.state === "ready" ? "loaded" : visual?.state === "unavailable" ? "unavailable" : "pending", message: visual?.state === "ready" ? "Read original pixels and visible text; supports only observable details, not unseen behaviour or compliance." : visual?.error || "Waiting for visual reading." });
  }
  await env.ASSETS.put(sourceReportKey(runId), JSON.stringify(results), { httpMetadata: { contentType: "application/json" } });
  if (urls.some((url) => !results.some((result) => result.source === url))) return false;
  // Availability alone is not readiness. The next stage assesses the actual
  // brief, or immediately asks for readable material without buying a draft.
  if (results.some((result) => result.status === "loaded")) await groundingForRun(env, campaign, runId);
  return true;
}

export async function groundingForRun(env: Env, campaign: Campaign, runId: string): Promise<string> {
  return (await groundingEvidenceForRun(env, campaign, runId)).text;
}
export async function groundingEvidenceForRun(env: Env, campaign: Campaign, runId: string): Promise<GroundingEvidence> {
  const report = await loadSourceReport(env, runId);
  const run = await runs.get(env.DB,runId);
  const images = run ? await visualSources(env,run) : [];
  if (images.length) {
    const docIds = report.filter((item) => item.status === "loaded" && item.docId).map((item) => item.docId!);
    const hasDocs = report.length ? docIds.length > 0 : (await groundingDocs.listForCampaign(env.DB,campaign.id)).length > 0;
    const documentEvidence = hasDocs ? await loadGroundingEvidence(env,campaign.id,{ ...(report.length ? {docIds} : {}), query: `${campaign.idea}\n${campaign.include_ideas}` }) : { sources: [] };
    const sources = [...documentEvidence.sources,...images];
    const budget = Math.floor(60000 / sources.length);
    const bounded = sources.map((source) => ({ ...source, body: sourceExcerpt(source.body,budget,`${campaign.idea}\n${campaign.include_ideas}`) }));
    return { text: sourcePrompt(bounded), sources: bounded };
  }
  if (campaign.article_type === "fiction" && !report.some((source) => source.status === "loaded")) return { text: "Fictional narrative: use the brief as creative premises, not verified factual evidence. Do not assert unsupported real-world claims.", sources: [] };
  const docIds = report.length ? report.filter((item) => item.status === "loaded" && item.docId).map((item) => item.docId!) : undefined;
  return loadGroundingEvidence(env, campaign.id, { docIds, query: `${campaign.idea}\n${campaign.include_ideas}` });
}
