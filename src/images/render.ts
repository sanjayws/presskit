/** Shared evidence-led rendering for initial images and image-only requests. */
import type { Env } from "../env";
import type { Article, Campaign } from "../db/repos";
import { toPlain } from "../content/render";
import { sha256Hex } from "../grounding/ingest";
import { optionInstruction, IMAGE_STYLES, channelProfile, isOutputFormat } from "../style/engine";
import { recordOf } from "../providers/http";
import { generateImage } from "../openai/image";
import { logEvent } from "../log";
import { featuredImagePrompt, planFeaturedImage, validateComposition, IMAGE_PROMPT_VERSION, IMAGE_SOURCE_LIMIT } from "./brief";

export async function renderFeaturedVisual(env: Env, article: Article, campaign: Campaign | null, options: {
  pngKey: string;
  briefKey: string;
  sourceBriefKeys?: string[];
  previousBriefKey?: string;
}): Promise<string> {
  // Recover a prior successful write without buying the same job twice.
  const existing = await env.ASSETS.head(options.pngKey);
  if (existing && existing.size <= 6_000_000 && existing.httpMetadata?.contentType === "image/png") return options.pngKey;
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI image generation is not configured");
  const input = {
    title: article.title, sourceText: toPlain(article.body_html),
    userBrief: campaign?.image_brief ?? "",
    styleDirection: optionInstruction(IMAGE_STYLES, campaign?.image_style ?? ""),
    outputFormat: isOutputFormat(article.output_format) ? article.output_format : "html" as const,
  };
  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst";
  const planner = { provider: "anthropic", model: env.ANTHROPIC_MODEL || "claude-opus-5-5", effort: env.ANTHROPIC_EFFORT || "low" };
  const inputHash = await sha256Hex(JSON.stringify({ input, planner }));
  let planned: Awaited<ReturnType<typeof planFeaturedImage>> | undefined;
  // A fresh job still reuses its OWN validated brief on transient delivery retries.
  for (const key of new Set([options.briefKey, ...(options.sourceBriefKeys ?? [])])) {
    const cached = await env.ASSETS.get(key);
    if (!cached || cached.size > 32_000) continue;
    try {
      const value = recordOf(await cached.json<unknown>());
      if (value.version === IMAGE_PROMPT_VERSION && value.model === model && value.inputHash === inputHash) {
        const composition = validateComposition(value.composition, input.sourceText.slice(0, IMAGE_SOURCE_LIMIT));
        planned = { composition, prompt: featuredImagePrompt(composition, input) };
        break;
      }
    } catch {
      logEvent("image.brief_cache_invalid", { article_id: article.id });
    }
  }
  if (!planned) {
    let previousConcept = "";
    if (options.previousBriefKey) {
      const previous = await env.ASSETS.get(options.previousBriefKey);
      if (previous && previous.size <= 32_000) {
        try {
          const c = recordOf(recordOf(await previous.json<unknown>()).composition);
          previousConcept = JSON.stringify({ layout: c.layout, headline: c.headline, artDirection: c.artDirection,
            points: Array.isArray(c.points) ? c.points.slice(0, 4).map((p) => { const v = recordOf(p); return { label: v.label, visual: v.visual }; }) : [] }).slice(0, 3000);
        } catch { logEvent("image.previous_brief_unreadable", { article_id: article.id }); }
      }
    }
    planned = await planFeaturedImage(env, { ...input, previousConcept });
  }
  // Snapshot source content for safe crash recovery if the article is edited later.
  await env.ASSETS.put(options.briefKey, JSON.stringify({
    version: IMAGE_PROMPT_VERSION, model, planner, inputHash,
    articleHash: await sha256Hex(JSON.stringify([article.title, article.body_html])), ...planned,
  }), { httpMetadata: { contentType: "application/json" } });
  const image = await generateImage(env, planned.prompt, channelProfile(input.outputFormat).imageSize);
  await env.ASSETS.put(options.pngKey, image.bytes, { httpMetadata: { contentType: image.mimeType } });
  return options.pngKey;
}
