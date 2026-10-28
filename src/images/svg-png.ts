/** Rasterize owned diagrams without changing their text or asking an image model to redraw them. */
import type { Env } from "../env";
import type { Article } from "../db/repos";
import { RetryableError, StageBusyError } from "../errors";
import { sha256Hex } from "../grounding/ingest";

const MAX_PNG_BYTES=6_000_000;
export class PngConversionError extends RetryableError {
  constructor(message="PNG conversion is temporarily unavailable. Your original diagram and article are kept. Try copying or downloading again shortly.") { super(message); }
}
export class PngConversionBusyError extends StageBusyError {
  constructor() { super(3); }
}
export function pngDiagramPage(svg:string):{html:string;width:number;height:number} {
  if (new TextEncoder().encode(svg).length>128000) throw new PngConversionError("This saved diagram is too large to convert. The original and article are kept.");
  const root=/^\s*<svg\b([^>]*)>/i.exec(svg);
  const width=Number(/\bwidth="([0-9]+)"/.exec(root?.[1] || "")?.[1]);
  const height=Number(/\bheight="([0-9]+)"/.exec(root?.[1] || "")?.[1]);
  if (!root || !svg.trim().endsWith("</svg>") || width<1 || height<1 || width>2048 || height>8192 || !Number.isInteger(width) || !Number.isInteger(height) || width*height>12_000_000) throw new PngConversionError("The saved diagram has invalid dimensions. The article is kept; download the original diagram for inspection.");
  let binary="";for (const byte of new TextEncoder().encode(svg)) binary+=String.fromCharCode(byte);
  // SVG is loaded as an image, never inserted as active HTML. No script or network access.
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}img{display:block;width:${width}px;height:${height}px}</style></head><body><img id="diagram" width="${width}" height="${height}" src="data:image/svg+xml;base64,${btoa(binary)}" alt=""></body></html>`;
  return {html,width,height};
}
async function readPng(response:Response,width:number,height:number):Promise<Uint8Array> {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/png") || Number(response.headers.get("content-length"))>MAX_PNG_BYTES) {
    await response.body?.cancel();throw new PngConversionError();
  }
  const reader=response.body?.getReader();if (!reader) throw new PngConversionError();
  const chunks:Uint8Array[]=[];let total=0;
  try {
    for (;;) { const {done,value}=await reader.read();if (done) break;total+=value.byteLength;if (total>MAX_PNG_BYTES) throw new PngConversionError();chunks.push(value); }
  } catch(error) { await reader.cancel().catch(()=>undefined);throw error; }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(total);let offset=0;for (const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.length; }
  const signature=[137,80,78,71,13,10,26,10];
  if (bytes.length<33 || !signature.every((b,i)=>bytes[i]===b) || new TextDecoder().decode(bytes.subarray(12,16))!=="IHDR") throw new PngConversionError();
  const view=new DataView(bytes.buffer);if (view.getUint32(16)!==width || view.getUint32(20)!==height) throw new PngConversionError();
  return bytes;
}
async function renderPng(env:Env,svg:string):Promise<{bytes:Uint8Array;width:number;height:number}> {
  if (!env.BROWSER) throw new PngConversionError("PNG conversion needs the existing BROWSER binding. Ask your administrator to check Browser Rendering; your original is kept.");
  const {html,width,height}=pngDiagramPage(svg);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const render=async()=>{
      const response=await env.BROWSER.quickAction("screenshot",{html,viewport:{width,height,deviceScaleFactor:1},setJavaScriptEnabled:false,rejectRequestPattern:[".*"],
        gotoOptions:{waitUntil:"load",timeout:10000},actionTimeout:10000,cacheTTL:0,
        screenshotOptions:{type:"png",encoding:"binary",clip:{x:0,y:0,width,height},captureBeyondViewport:false},
      });
      return {bytes:await readPng(response,width,height),width,height};
    };
    return await Promise.race([render(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PngConversionError()),25000);})]);
  } catch { throw new PngConversionError(); }
  finally { if (timer) clearTimeout(timer); }
}
/** Cache is tied to original bytes; a shared lease prevents concurrent paid browser conversions. */
export async function ensureInlinePng(env:Env,articleId:string,slot:number,allowRender=true):Promise<R2ObjectBody> {
  if (!/^[a-zA-Z0-9_-]+$/.test(articleId) || !Number.isInteger(slot) || slot<1 || slot>3) throw new PngConversionError();
  const prefix=`articles/${articleId}/inline-images/${slot}`,pngKey=`${prefix}.png`;
  const source=await env.ASSETS.get(`${prefix}.svg`);
  if (!source || source.size>128000) { await source?.body.cancel();throw new PngConversionError("The saved diagram is missing or too large to convert. Your article is kept. Try its original image download or contact your administrator."); }
  const svg=await source.text(),sourceHash=await sha256Hex(svg);
  const cached=async()=>{
    const object=await env.ASSETS.get(pngKey);
    if (object && object.size<=MAX_PNG_BYTES && object.httpMetadata?.contentType==="image/png" && object.customMetadata?.sourceHash===sourceHash) return object;
    await object?.body.cancel();return null;
  };
  const existing=await cached();if (existing) return existing;
  if (!allowRender) throw new PngConversionError("The diagram reached its PNG conversion retry limit. The original diagram and article are kept.");
  const leaseKey=`svg-png:${prefix}`,owner=crypto.randomUUID(),now=Date.now();
  const claim=await env.DB.prepare(`INSERT INTO image_read_leases(asset_key,owner,lease_until) VALUES (?,?,?)
    ON CONFLICT(asset_key) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE image_read_leases.lease_until<=?`)
    .bind(leaseKey,owner,now+60000,now).run();
  if (!claim.meta.changes) throw new PngConversionBusyError();
  try {
    const winner=await cached();if (winner) return winner;
    const {bytes,width,height}=await renderPng(env,svg);
    const current=await env.ASSETS.head(`${prefix}.svg`);
    const lease=await env.DB.prepare("SELECT owner FROM image_read_leases WHERE asset_key=? AND lease_until>?").bind(leaseKey,Date.now()).first<{owner:string}>();
    if (current?.etag!==source.etag || lease?.owner!==owner) throw new PngConversionError();
    await env.ASSETS.put(pngKey,bytes,{httpMetadata:{contentType:"image/png"},customMetadata:{sourceHash,convertedFrom:"svg",width:String(width),height:String(height)}});
    const result=await cached();if (!result) throw new PngConversionError();return result;
  } finally { await env.DB.prepare("DELETE FROM image_read_leases WHERE asset_key=? AND owner=?").bind(leaseKey,owner).run(); }
}
/** Render legacy WordPress URLs as PNG without rewriting the saved draft or its review. */
export function wordpressInlineHtml(article:Pick<Article,"id"|"body_html"|"output_format">):string {
  if (article.output_format!=="html" || !/^[a-zA-Z0-9_-]+$/.test(article.id)) return article.body_html;
  const prefix=`/articles/${article.id}/inline-images/`;
  return article.body_html.replace(/<img\b[^>]*>/gi,tag=>tag.replace(/\bsrc="([^"]*)"/i,(attr,src:string)=>src.startsWith(prefix) && /^[1-3]\.svg$/.test(src.slice(prefix.length)) ? `src="${src.slice(0,-4)}.png"` : attr));
}
