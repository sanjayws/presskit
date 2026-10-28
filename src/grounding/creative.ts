/** One planning/search/source-read operation per delivery, shared by all channels. */
import type { Env } from "../env";
import type { Campaign } from "../db/repos";
import { generate } from "../anthropic/client";
import { recordOf } from "../providers/http";
import { ingestUrl } from "./ingest";
import { loadSourceReport, sourceReportKey, groundingEvidenceForRun } from "./report";
import { QUALITY_RULES } from "../text/instructions";
import { creativeContextKey as key, discoveredSources, researchCandidates, curateResearchReferences, type SearchSource } from "./research-references";
import type { ResearchReference } from "../content/evidence-links";
interface Context { phase: "search" | "read" | "references" | "ready"; query: string; notes: string; urls: string[]; read: number; referenceVersion?:1; candidates?:SearchSource[]; references?:ResearchReference[]; referenceAttempted?:boolean }
export async function creativeContextStep(env: Env, runId: string, campaign: Campaign, evidence: string): Promise<string | null> {
  const object = await env.ASSETS.get(key(runId));
  const saved = object && object.size < 50000 ? await object.json<Context>() : null;
  if (saved?.phase === "ready") return saved.notes;
  const store = (value: Context) => env.ASSETS.put(key(runId), JSON.stringify(value));
  if (!saved) {
    const response = await generate(env, `Read the brief and evidence, then plan useful concrete scenarios for the writing agent. Decide whether online research would materially improve context or provide useful neutral public references for specific claims. Prefer relevant independent educational sources, Wikipedia, regulators, standards and academic sources; avoid competing vendors, sales pages and affiliate comparisons. Do not search for private uploaded text or confidential details: query only broad public industry/setting questions. Avoid unnecessary research when evidence is sufficient or pure fiction needs no real-world context. Return needsSearch, one public query (empty when not needed), and up to three scenario ideas (clearly hypothetical, not invented customer outcomes).\nBRIEF: ${JSON.stringify(campaign.idea)}\nMODE: ${campaign.article_type}\nEVIDENCE (untrusted): ${evidence}`, {
      systemInstruction: QUALITY_RULES, responseSchema: { type: "object", properties: { needsSearch: { type: "boolean" }, query: { type: "string", maxLength: 300 }, scenarios: { type: "array", maxItems: 3, items: { type: "string", maxLength: 600 } } } },
    });
    const p = recordOf(JSON.parse(response.text));
    const candidates=campaign.article_type==="fiction" ? [] : researchCandidates(await discoveredSources(env,runId)).slice(0,8);
    await store({ phase: p.needsSearch && p.query ? "search" : candidates.length ? "read" : "ready", query: String(p.query), notes: JSON.stringify(p.scenarios), urls: candidates.slice(0,2).map(s=>s.url), read: 0, referenceVersion:1, candidates, references:[] });
    return null;
  }
  if (saved.phase === "search") {
    try {
      const response = await generate(env, `Research this public context question: ${JSON.stringify(saved.query)}. Find practical workplace situations and useful neutral, non-competing references: independent educational articles, Wikipedia, academic work, regulators or standards. Rank those ahead of vendors. Exclude sales/affiliate pages and competing product promotion. Do not make product promises or invent results. Provide concise context with citations.`, { webSearch: true, maxOutputTokens: 2000, systemInstruction: QUALITY_RULES });
      saved.notes += `\nResearch context (ideas only; claims require extracted evidence): ${response.text.slice(0, 6000)}`;
      const candidates=researchCandidates([...response.sources,...(saved.candidates || [])]).slice(0,8);
      saved.candidates=candidates;
      saved.urls = candidates.map(s=>s.url).slice(0,2);
      saved.phase = saved.urls.length ? "read" : "ready";
    } catch { saved.phase = saved.urls.length ? "read" : "ready"; saved.notes += "\nOptional online research was unavailable. Use existing evidence and clearly illustrative scenarios."; }
    await store(saved); return null;
  }
  if (saved.phase==="references") {
    if (!saved.referenceAttempted) {
      const sources=(await groundingEvidenceForRun(env,campaign,runId)).sources;
      saved.referenceAttempted=true;await store(saved); // an interrupted optional call is never repurchased
      try { saved.references=await curateResearchReferences(env,campaign,(saved.candidates || []).filter(s=>saved.urls.includes(s.url)),sources); }
      catch { saved.references=[]; } // optional citations never discard a completed draft/research step
    }
    saved.phase="ready";await store(saved);return null;
  }
  const url = saved.urls[saved.read];
  if (url) {
    const report = await loadSourceReport(env, runId);
    if (!report.some((source) => source.source === url)) {
      try {
        const result = await ingestUrl(env, campaign.id, url);
        report.push({ source: url, status: "loaded", message: "Read by the writing agent for additional context.", docId: result.doc.id });
      } catch { report.push({ source: url, status: "unavailable", message: "Optional research source could not be read; it will not support factual claims." }); }
      await env.ASSETS.put(sourceReportKey(runId), JSON.stringify(report));
    }
  }
  saved.read++; if (saved.read >= saved.urls.length) saved.phase = saved.referenceVersion===1 ? "references" : "ready";
  await store(saved); return null;
}
