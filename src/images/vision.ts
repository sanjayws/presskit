import type { Env } from "../env";
import type { BuildImage } from "./uploads";
import { imageTag, MAX_IMAGE_BYTES, runImages } from "./uploads";
import { readImage, type VisualReading } from "../openai/vision";
import { isTransientFailure } from "../errors";
import type { Run } from "../db/repos";
import type { GroundingSource } from "../grounding/evidence";
export interface SavedVisual { version: 1; state: "pending" | "ready" | "unavailable"; attempts: number; reading?: VisualReading; error?: string }
export const visualKey = (image: BuildImage) => `${image.r2_key}/visual.json`;
export async function loadVisual(env: Env, image: BuildImage): Promise<SavedVisual | null> {
  const object = await env.ASSETS.get(visualKey(image));
  return object && object.size <= 32000 ? object.json<SavedVisual>() : null;
}
export function visualBody(reading: VisualReading): string {
  return `AI visual extraction of the ORIGINAL uploaded image. Supports only what is visibly shown; not independent verification of claims, identities, feature operation or compliance.\nObservable content: ${reading.description}\nClearly visible text (transcription):\n${reading.visibleText || "No readable text is visible."}\nReading limits: ${reading.uncertainty || "No additional uncertainty reported; AI reading can still make mistakes."}`;
}
/** Processes at most one original per delivery, with three lifetime attempts per saved image. */
export async function readBuildImagesStep(env: Env, images: BuildImage[]): Promise<boolean> {
  for (const image of images) {
    const saved = await loadVisual(env,image);
    if (saved?.state === "ready" || saved?.state === "unavailable") continue;
    const checkpoint: SavedVisual = { version: 1, state: "pending", attempts: (saved?.attempts || 0)+1 };
    await env.ASSETS.put(visualKey(image),JSON.stringify(checkpoint));
    try {
      if (checkpoint.attempts > 3) throw new Error("Image reading reached its retry limit.");
      const original = await env.ASSETS.get(image.r2_key);
      if (!original || original.size > MAX_IMAGE_BYTES) throw new Error("The saved image is unavailable.");
      const reading = await readImage(env,new Uint8Array(await original.arrayBuffer()),image.content_type);
      checkpoint.reading = reading; checkpoint.state = "ready";
    } catch (error) {
      if (isTransientFailure(error) && checkpoint.attempts < 3) throw error;
      checkpoint.state = "unavailable";
      const message = error instanceof Error ? error.message : "";
      checkpoint.error = /401|403|OPENAI_API_KEY/.test(message) ? "Image reading could not authenticate. Ask your administrator to check the OpenAI key and image-input model access; add readable supporting text meanwhile."
        : /429|quota|billing/i.test(message) ? "Image reading reached the OpenAI usage limit. Ask your administrator to check billing/model limits. The original is kept; add readable supporting text meanwhile."
        : /400|404/.test(message) ? "The AI service could not process this image. Check that the configured document model supports image inputs and that the original opens correctly; try a clear PNG copy or readable supporting text."
        : "This image could not be read reliably within the retry limit. Its original is kept. Add readable supporting text or upload a clearer crop; other available sources can still support the article.";
    }
    await env.ASSETS.put(visualKey(image),JSON.stringify(checkpoint));
    return false;
  }
  return true;
}
export async function visualSources(env: Env, run: Run): Promise<GroundingSource[]> {
  const sources: GroundingSource[] = [];
  for (const image of runImages(run)) {
    const saved = await loadVisual(env,image);
    if (saved?.state === "ready" && saved.reading) sources.push({ id: `image_${image.id}`, label: `Original image ${imageTag(image)} (${image.filename}); AI visual extraction`, body: visualBody(saved.reading) });
  }
  return sources;
}
export function imageNarrativeContext(images: BuildImage[]): string {
  if (!images.length) return "";
  return `Uploaded image narrative map (owner preferences, NOT evidence). Read the separate original-image visual source records. Make the surrounding narrative relevant to what those images actually show; respect each useWhen instruction when supported by evidence. Image tags identify assets internally: never print the tags, placement directions, file names or processing notes in publishable prose. Do not claim a control works or a product is compliant merely because a screenshot displays a label. Do not invent details hidden outside the frame. ${JSON.stringify(images.map((image) => ({ imageId: image.id, tag: imageTag(image), ownerDescription: image.description, useWhen: image.use_when || "", role: image.role })))}`;
}

/** Reuse only successful visual reads from this owner's Auto decide job and identical bytes. */
export async function reuseAutoImageReadings(env: Env,userId: string,jobId: string,images: BuildImage[]): Promise<void> {
  if (!/^opt_[a-f0-9]{32}$/.test(jobId) || !images.length) return;
  const job = await env.DB.prepare("SELECT id FROM brief_option_jobs WHERE id=? AND user_id=? AND state='ready' AND created_at>?").bind(jobId,userId,Date.now()-86400000).first();
  if (!job) return;
  const object = await env.ASSETS.get(`brief-options/${jobId}/request.json`);
  if (!object || object.size>500000) return;
  const request = await object.json<{images?:BuildImage[]}>();
  for (const image of images) {
    if (!image.sha256) continue;
    const previous = request.images?.find((item)=>item.sha256===image.sha256);
    if (!previous) continue;
    const reading=await loadVisual(env,previous);
    if (reading?.state==="ready" && reading.reading) await env.ASSETS.put(visualKey(image),JSON.stringify(reading));
  }
}
