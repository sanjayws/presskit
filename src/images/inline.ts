import { seoAgentInstructions } from "../seo/skills";
import { planSvgDiagram, renderSvgDiagram, validateDiagram, type SvgDiagram } from "./svg";
/** Private, checkpointed inline illustrations. A delivery plans OR renders one asset. */
import type { Env } from "../env";
import { articles, type Article, type Campaign } from "../db/repos";
import { generate } from "../anthropic/client";
import { generateImage, generateMotionImage } from "../openai/image";
import { prepareMotion, InvalidMotionError, supportsMotionModel, motionDisabled, type MotionRaster } from "./gif";
import { recordOf } from "../providers/http";
import { sha256Hex } from "../grounding/ingest";
import { toPlain, renderOutput, isRichFormat } from "../content/render";
import { isOutputFormat } from "../style/engine";
import { imageCropSafety } from "./brief";
import { RetryableError, isTransientFailure } from "../errors";
import { stripUploadedImages, exportUploadedHtml, MAX_EMBEDDED_IMAGE_BYTES, EmbeddedImageLimitError } from "./uploads";
import { ensureInlinePng } from "./svg-png";
import { StageBusyError } from "../errors";
import { INLINE_VISUAL_DIRECTION, inlineScenePrompt, sceneInsteadOfDiagram } from "./inline-direction";

export type InlineKind = "png" | "svg" | "gif";
export interface InlineSlot { kind?: InlineKind; motion?:boolean; width?: number; height?: number; sourceText?: string; diagram?: SvgDiagram; afterParagraph: number; alt: string; prompt: string; state: "pending" | "ready" | "failed"; attempts: number; rasterAttempts?:number }
export interface InlineManifest { version: 1; baseHash: string; slots: InlineSlot[]; planned?: boolean; planAttempts?: number; error?: string }
export const inlineKey = (id: string, slot: number, kind: InlineKind = "png") => `articles/${id}/inline-images/${slot}.${kind}`;
export const inlineUrl = (id: string, slot: number, kind: InlineKind = "png") => `/articles/${id}/inline-images/${slot}.${kind}`;
export const inlineKind = (slot: InlineSlot): InlineKind => slot.kind || "png";
export const inlineAssetKind = (slot:InlineSlot,format:string):InlineKind => format==="html" && inlineKind(slot)==="svg" || format==="word" && inlineKind(slot)==="gif" ? "png" : inlineKind(slot);
export async function inlineAsset(env:Env,article:Article,index:number,slot:InlineSlot):Promise<R2ObjectBody|null> {
  return article.output_format==="html" && inlineKind(slot)==="svg" ? ensureInlinePng(env,article.id,index+1) : env.ASSETS.get(inlineKey(article.id,index+1,inlineAssetKind(slot,article.output_format)));
}
export const supportsSvgInline = (format: string) => ["html", "markdown"].includes(format);
export const supportsMotionInline = (format:string) => ["html","email","markdown"].includes(format);
export const motionSourceKey = (id:string,slot:number) => `articles/${id}/inline-images/${slot}.source.gif`;
const manifestKey = (id: string) => `articles/${id}/inline-images/manifest.json`;
export const supportsInline = (format: string) => ["html", "email", "word", "markdown"].includes(format);
export async function loadInline(env: Env, id: string): Promise<InlineManifest | null> {
  const object = await env.ASSETS.get(manifestKey(id));
  if (!object || object.size > 60000) return null;
  const value = await object.json<InlineManifest>();
  if (value.version !== 1 || !Array.isArray(value.slots) || value.slots.length > 3 || value.slots.some((s) => !Number.isInteger(s.afterParagraph) || s.afterParagraph < 1 || typeof s.alt !== "string" || s.alt.length > 240 || typeof s.prompt !== "string" || s.prompt.length > 4000 || !["pending", "ready", "failed"].includes(s.state) || !Number.isInteger(s.attempts) || (s.kind !== undefined && !["png", "svg", "gif"].includes(s.kind)) || (s.sourceText !== undefined && (typeof s.sourceText !== "string" || s.sourceText.length > 6000)))) throw new Error("Invalid inline image checkpoint");
  for (const slot of value.slots) if (slot.diagram) validateDiagram(slot.diagram, slot.sourceText || "");
  for(const slot of value.slots)if(slot.motion!==undefined && (typeof slot.motion!=="boolean" || slot.motion && inlineKind(slot)!=="svg"))throw new Error("Invalid SVG motion checkpoint");
  for (const slot of value.slots) if (slot.rasterAttempts!==undefined && (!Number.isInteger(slot.rasterAttempts) || slot.rasterAttempts<0)) throw new Error("Invalid PNG conversion checkpoint");
  for (const slot of value.slots) if ([slot.width, slot.height].some((n) => n !== undefined && (!Number.isInteger(n) || n < 1 || n > 8192))) throw new Error("Invalid inline image dimensions");
  return value;
}
const save = (env: Env, id: string, value: InlineManifest) => env.ASSETS.put(manifestKey(id), JSON.stringify(value));
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const stripInline = (html: string) => html.replace(/<figure\b[^>]*data-presskit-inline="[1-3]"[^>]*>[\s\S]*?<\/figure>/gi, "");
export async function insertInline(html: string, id: string, slots: InlineSlot[],format="markdown"): Promise<string> {
  let index = 0;
  const rewriter = new HTMLRewriter().on("p", { element(el) {
    const paragraph = ++index;
    const figures = slots.flatMap((slot, i) => {
      if(slot.state!=="ready" || slot.afterParagraph!==paragraph)return [];
      const kind=inlineAssetKind(slot,format),img=`<img src="${inlineUrl(id,i+1,kind)}" alt="${escape(slot.alt)}"${slot.width && slot.height ? ` width="${slot.width}" height="${slot.height}"` : ""} loading="lazy" decoding="async">`;
      return [`<figure data-presskit-inline="${i+1}">${kind==="gif" ? `<picture><source media="(prefers-reduced-motion: reduce)" srcset="${inlineUrl(id,i+1,"png")}">${img}</picture>` : img}</figure>`];
    }).join("");
    if (figures) el.after(figures, { html: true });
  } });
  return rewriter.transform(new Response(stripInline(html))).text();
}

async function persistMotion(env:Env,id:string,index:number,result:MotionRaster & {original:Uint8Array}):Promise<void>{
  await env.ASSETS.put(motionSourceKey(id,index),result.original,{httpMetadata:{contentType:"image/gif"}});
  const customMetadata={width:String(result.width),height:String(result.height),motionVersion:"1",frames:String(result.frames)};
  await env.ASSETS.put(inlineKey(id,index,"png"),result.poster,{httpMetadata:{contentType:"image/png"},customMetadata});
  await env.ASSETS.put(inlineKey(id,index,"gif"),result.bytes,{httpMetadata:{contentType:"image/gif"},customMetadata});
}

export async function inlineImageStep(env: Env, article: Article, campaign: Campaign | null): Promise<boolean> {
  const count = Math.min(3, Math.max(0, campaign?.inline_image_count || 0));
  if (!count || !supportsInline(article.output_format)) return true;
  const base = stripUploadedImages(stripInline(article.body_html));
  const hash = await sha256Hex(base);
  let manifest = await loadInline(env, article.id);
  if (manifest && manifest.baseHash !== hash) return true; // preserve manual edits; never silently regenerate
  const paragraphs = [...base.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((p, i) => ({ number: i + 1, text: toPlain(p[0]) }));
  if (!manifest || manifest.planned === false) {
    if (!paragraphs.length) { await save(env, article.id, { version: 1, baseHash: hash, slots: [], error: "No paragraph placement is available." }); return true; }
    const planAttempts = (manifest?.planAttempts || 0) + 1;
    await save(env, article.id, { version: 1, baseHash: hash, slots: [], planned: false, planAttempts });
    try {
      const allowMotion=!motionDisabled(campaign?.image_brief || "");
      const motion=supportsMotionInline(article.output_format) && supportsMotionModel(env.OPENAI_IMAGE_MODEL || "gpt-image-2.6-sunburst") && allowMotion;
      const svgMotion=supportsSvgInline(article.output_format) && allowMotion;
      const kinds=["png",...(supportsSvgInline(article.output_format) ? ["svg"] : []),...(motion ? ["gif"] : []),...(svgMotion ? ["svg_motion"] : [])];
      const result = await generate(env, `Read this final draft and plan ${Math.min(count, paragraphs.length)} distinct inline illustrations besides the hero. Place each after a relevant paragraph; use different paragraph numbers. Write a vivid, creative visual prompt grounded in that passage, not a repeated hero image. Use kind=png for a specific editorial scene, a relatable work moment or a tangible visual metaphor by default. Choose kind=svg only when a precise relationship or sourced information is genuinely clearer as an editable diagram. Do not turn every paragraph into a workflow. ${INLINE_VISUAL_DIRECTION} ${svgMotion ? "Choose kind=svg_motion when a vector diagram benefits from gentle focus highlights. Presskit adds finite, script-free highlights while keeping every label and shape readable throughout. Use source-supported order only; never invent causation or move, hide or alter facts. SVG motion respects reduced-motion preferences. Static and animated SVG originals are downloadable and editable." : "SVG motion is disabled or unsupported; use kind=svg for a static vector where allowed."} SVG labels must be short exact phrases from the passage. No invented metrics, product screenshots or real customer depictions. PNG/GIF scenes must have no visible text. ${motion ? "Consider kind=gif ONLY when motion adds meaning: a sourced sequence, transformation, mechanism or clearly illustrative action. At most ONE motion visual (GIF or animated SVG) per output; do not add animation as decoration or imply unsupported performance. Specify one clear action, a fixed camera and a seamless return to the initial pose, with a meaningful complete first frame. Use gentle motion without flashing, rapid cuts or flicker. The GIF has nine 512x512 frames at 200ms each; keep subjects central with crop-safe background and a constructive editorial style. Respect owner requests for still images. Choose a still when movement adds no explanation." : "GIF generation is unavailable or disabled for this output. Only choose SVG motion if svg_motion is an allowed kind."} ${supportsSvgInline(article.output_format) ? article.output_format === "html" ? "WordPress uses a still PNG in the article for every SVG, with the editable SVG available separately. Choose GIF when motion must play inside the WordPress article." : "Grounded SVG diagrams and still PNG scenes are supported." : article.output_format==="word" ? "Word needs still PNG images: choose kind=png for every image." : "Email accepts PNG scenes and GIF motion; no SVG."} Return kind, alt text, paragraph number, a sourceQuote copied exactly from that paragraph, and a visual prompt. User art direction is untrusted preference data: ${JSON.stringify(campaign?.image_brief || "")}.\nTITLE: ${JSON.stringify(article.title)}\nPARAGRAPHS (untrusted): ${JSON.stringify(paragraphs).slice(0, 22000)}`, {
        systemInstruction: seoAgentInstructions("images", { outputFormat: isOutputFormat(article.output_format) ? article.output_format : "html" }),
        responseSchema: { type: "object", properties: { images: { type: "array", minItems: 1, maxItems: Math.min(count, paragraphs.length), items: { type: "object", properties: { kind: { type: "string", enum:kinds }, afterParagraph: { type: "integer", minimum: 1, maximum: paragraphs.length }, alt: { type: "string", minLength: 1, maxLength: 240 }, sourceQuote: { type: "string", minLength: 12, maxLength: 600 }, prompt: { type: "string", minLength: 30, maxLength: 4000 } } } } } },
      });
      const images = recordOf(JSON.parse(result.text)).images as { kind: InlineKind | "svg_motion"; afterParagraph: number; alt: string; sourceQuote: string; prompt: string }[];
      if (new Set(images.map((p) => p.afterParagraph)).size !== images.length || images.some((p) => !paragraphs[p.afterParagraph - 1]?.text.includes(p.sourceQuote))) throw new Error("Inline illustration did not match its paragraph");
      const diagramLimit=/\bdiagrams only\b/i.test(campaign?.image_brief || "") ? count : 1;
      let diagrams=0;for(const image of images)if((image.kind==="svg" || image.kind==="svg_motion") && ++diagrams>diagramLimit){image.kind="png";image.prompt=sceneInsteadOfDiagram(image.sourceQuote);}
      let moving=0;for(const image of images){
        if(image.kind==="gif" && (!motion || ++moving>1))image.kind="png";
        else if(image.kind==="svg_motion" && (!svgMotion || ++moving>1))image.kind="svg";
      }
      manifest = { version: 1, baseHash: hash, planned: true, planAttempts, slots: images.map(({ kind:plannedKind, afterParagraph, alt, prompt }) => {
        const kind:InlineKind=plannedKind==="svg_motion" ? "svg" : plannedKind;
        return {kind,...(plannedKind==="svg_motion" ? {motion:true} : {}),...(kind==="svg" ? {sourceText:paragraphs[afterParagraph-1]!.text.slice(0,6000)} : {}),afterParagraph,alt,prompt,state:"pending",attempts:0};
      }) };
    } catch (error) {
      if (error instanceof RetryableError && planAttempts < 3) throw error;
      manifest = { version: 1, baseHash: hash, slots: [], error: "Inline image planning could not finish. The article and hero remain available." };
    }
    await save(env, article.id, manifest); return false;
  }
  const index = manifest.slots.findIndex((slot) => slot.state === "pending");
  if (index >= 0) {
    const slot = manifest.slots[index]!;
    const kind = inlineKind(slot);
    const key = inlineKey(article.id, index + 1, kind);
    const cached = await env.ASSETS.head(key);
    if(kind==="gif" && (cached || await env.ASSETS.head(motionSourceKey(article.id,index+1)))){
      try{
        const poster=await env.ASSETS.head(inlineKey(article.id,index+1,"png"));
        if(cached?.customMetadata?.motionVersion==="1" && cached.httpMetadata?.contentType==="image/gif" && cached.size<=6000000 && poster?.customMetadata?.motionVersion==="1" && poster.httpMetadata?.contentType==="image/png" && poster.size<=6000000){
          slot.width=Number(cached.customMetadata.width);slot.height=Number(cached.customMetadata.height);
        }else{
          const source=await env.ASSETS.get(motionSourceKey(article.id,index+1)) || await env.ASSETS.get(key);
          if(!source || source.size>6_000_000){await source?.body.cancel();throw new InvalidMotionError();}
          const original=new Uint8Array(await source.arrayBuffer()),result=prepareMotion(original);await persistMotion(env,article.id,index+1,{...result,original});slot.width=result.width;slot.height=result.height;
        }
        slot.state="ready";
      }catch(error){if(!(error instanceof InvalidMotionError))throw error;slot.kind="png";slot.state="pending";manifest.error="A motion visual could not be completed. A still image will be used instead.";}
    }else if (cached) {
      const width = Number(cached.customMetadata?.width), height = Number(cached.customMetadata?.height);
      if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192) { slot.width = width; slot.height = height; }
      slot.state = "ready";
      if (kind==="svg" && article.output_format==="html") {
        slot.state="pending";
        slot.rasterAttempts=Math.min(4,(slot.rasterAttempts || 0)+1);await save(env,article.id,manifest);
        try {
          const png=await ensureInlinePng(env,article.id,index+1,slot.rasterAttempts<=3);await png.body.cancel();slot.state="ready";
        } catch(error) {
          if (error instanceof StageBusyError) { slot.rasterAttempts--;slot.state="pending";await save(env,article.id,manifest);throw error; }
          if (isTransientFailure(error) && slot.rasterAttempts<3) {slot.state="pending";await save(env,article.id,manifest);throw error;}
          slot.state="failed";manifest.error="An inline diagram could not be converted to PNG. The original diagram and article are kept; other visuals remain available.";
        }
      }
    }
    else if (slot.attempts >= 3) {
      slot.state = "failed"; manifest.error = "An inline visual reached its retry limit. Other visuals and the article are kept.";
    } else {
      slot.attempts++;
      await save(env, article.id, manifest); // bound paid calls even when the worker is interrupted
      try {
        if (kind === "svg") {
          if (!slot.diagram) {
            slot.diagram = await planSvgDiagram(env, slot.prompt, slot.sourceText || "");
            await save(env, article.id, manifest); // a storage retry reuses the AI's diagram specification
          }
          const svg = renderSvgDiagram(slot.diagram, slot.alt,slot.motion===true);
          const size = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg);
          slot.width = Number(size?.[1]); slot.height = Number(size?.[2]);
          await env.ASSETS.put(key, svg, { httpMetadata: { contentType: "image/svg+xml" }, customMetadata: { width: String(slot.width), height: String(slot.height) } });
        } else if(kind==="gif"){
          let result;
          try{result=await generateMotionImage(env,inlineScenePrompt(slot.prompt,true));}
          catch(error){
            if((error instanceof InvalidMotionError || isTransientFailure(error) && slot.attempts>=2) && slot.attempts<3){slot.kind="png";slot.state="pending";manifest.error="Motion was unavailable; a still illustration is used instead.";await save(env,article.id,manifest);return false;}
            throw error;
          }
          await persistMotion(env,article.id,index+1,result);slot.width=result.width;slot.height=result.height;
        } else {
          const result = await generateImage(env, `${inlineScenePrompt(slot.prompt,false,/\bdiagrams only\b/i.test(campaign?.image_brief || ""))}\n${imageCropSafety("html")}`, "1536x1024");
          if (result.bytes.length >= 24) {
            const data = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
            const width = data.getUint32(16), height = data.getUint32(20);
            if (width > 0 && height > 0 && width <= 8192 && height <= 8192) { slot.width = width; slot.height = height; }
          }
          await env.ASSETS.put(key, result.bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: slot.width && slot.height ? { width: String(slot.width), height: String(slot.height) } : {} });
        }
        slot.state = kind==="svg" && article.output_format==="html" ? "pending" : "ready";
      } catch (error) {
        if (isTransientFailure(error) && slot.attempts < 3) { await save(env, article.id, manifest); throw error; }
        slot.state = "failed";
        manifest.error = "An inline image could not be generated. Other images and the article are kept.";
      }
    }
    await save(env, article.id, manifest);
    return false;
  }
  const body_html = await insertInline(base, article.id, manifest.slots,article.output_format);
  const format = isOutputFormat(article.output_format) ? article.output_format : "html";
  await articles.updateIfCurrent(env.DB, article, { body_html, output_body: isRichFormat(format) ? "" : renderOutput(body_html, format, { title: article.title, excerpt: article.excerpt, keyPhrases: [], maxWords: Number.MAX_SAFE_INTEGER }).body });
  return true;
}

/** Rewrite only this article's owned asset URLs; ZIPs use local files, HTML downloads embed the owned PNG/SVG assets. */
export async function exportInlineHtml(env: Env, article: Article, localFiles = false): Promise<string> {
  const embeddedBudget = {bytes:0};
  let body = await exportUploadedHtml(env, article, localFiles,embeddedBudget);
  const manifest = await loadInline(env, article.id);
  for (const [index, slot] of (manifest?.slots || []).entries()) {
    if (slot.state !== "ready") continue;
    const kind = inlineAssetKind(slot,article.output_format),sourceUrl=inlineUrl(article.id,index+1,inlineKind(slot)),assetUrl=inlineUrl(article.id,index+1,kind);
    if (!body.includes(sourceUrl) && !body.includes(assetUrl)) continue;
    const file = `inline-${index + 1}.${kind}`;
    let replacement = file;
    if (!localFiles || kind!==inlineKind(slot)) {
      const object = await inlineAsset(env,article,index,slot);
      if (!object || object.size > 6000000) {await object?.body.cancel();if(kind==="gif")throw new Error("The motion image is unavailable. Try downloading again.");continue;}
      if (localFiles) { await object.body.cancel();body=body.split(sourceUrl).join(replacement).split(assetUrl).join(replacement);continue; }
      embeddedBudget.bytes += object.size;
      if (embeddedBudget.bytes > MAX_EMBEDDED_IMAGE_BYTES) { await object.body.cancel(); throw new EmbeddedImageLimitError(); }
      const bytes = new Uint8Array(await object.arrayBuffer()); let binary = "";
      for (let p = 0; p < bytes.length; p += 8192) binary += String.fromCharCode(...bytes.subarray(p, p + 8192));
      replacement = `data:${kind === "svg" ? "image/svg+xml" : kind==="gif" ? "image/gif" : "image/png"};base64,${btoa(binary)}`;
    }
    body = body.split(sourceUrl).join(replacement).split(assetUrl).join(replacement);
    if(inlineKind(slot)==="gif"){
      const posterUrl=inlineUrl(article.id,index+1,"png");let poster=`inline-${index+1}.png`;
      if(!localFiles && body.includes(posterUrl)){
        const object=await env.ASSETS.get(inlineKey(article.id,index+1,"png"));if(!object || object.size>6_000_000)throw new Error("The motion still is unavailable. Try downloading again.");
        embeddedBudget.bytes+=object.size;if(embeddedBudget.bytes>MAX_EMBEDDED_IMAGE_BYTES){await object.body.cancel();throw new EmbeddedImageLimitError();}
        let binary="";const bytes=new Uint8Array(await object.arrayBuffer());for(let p=0;p<bytes.length;p+=8192)binary+=String.fromCharCode(...bytes.subarray(p,p+8192));poster=`data:image/png;base64,${btoa(binary)}`;
      }
      body=body.split(posterUrl).join(poster);
    }
  }
  return body;
}
