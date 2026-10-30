import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { env,createExecutionContext,waitOnExecutionContext } from "cloudflare:test";
import { zlibSync,unzipSync,strFromU8 } from "fflate";
import { fetchMock } from "./network";
import worker from "../src/index";
import { users,campaigns,runs,articles } from "../src/db/repos";
import { inlineImageStep,loadInline,inlineKey,inlineUrl,exportInlineHtml,stripInline,type InlineManifest } from "../src/images/inline";
import { ensureInlinePng,pngDiagramPage,PngConversionError,PngConversionBusyError,wordpressInlineHtml } from "../src/images/svg-png";
import { renderSvgDiagram } from "../src/images/svg";
import { inspectPng } from "../src/images/png";
import { sha256Hex } from "../src/grounding/ingest";
import { buildBundle } from "../src/bundle/export";

const source="Assess the network, then run a pilot, and review the results.";
const diagram={layout:"flow" as const,palette:"teal" as const,nodes:[{label:"Assess the network",detail:"",sourceQuote:source},{label:"run a pilot",detail:"",sourceQuote:source},{label:"review the results",detail:"",sourceQuote:source}]};
/** Valid compressed PNG fixture, with the exact requested raster dimensions. */
function png(width:number,height:number,raster=new Uint8Array(height*(width*3+1)),corruptChecksum=false):Uint8Array {
  const bytes:number[]=[137,80,78,71,13,10,26,10];
  function chunk(type:string,data:Uint8Array){const payload=new Uint8Array(4+data.length);payload.set(new TextEncoder().encode(type));payload.set(data,4);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let n=0;n<8;n++)crc=crc&1 ? 0xedb88320^(crc>>>1) : crc>>>1;}crc=(crc^0xffffffff)>>>0;const append=(n:number)=>bytes.push(n>>>24&255,n>>>16&255,n>>>8&255,n&255);append(data.length);for(const byte of payload)bytes.push(byte);append(crc);}
  const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
  const compressed=zlibSync(raster);if(corruptChecksum)compressed[compressed.length-1]=compressed[compressed.length-1]!^1;
  chunk("IHDR",header);chunk("IDAT",compressed);chunk("IEND",new Uint8Array());return new Uint8Array(bytes);
}
async function fixture(){
  const email=`png-${crypto.randomUUID()}@example.com`,user=await users.upsertByEmail(env.DB,email);
  const campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Explain the practical pilot",grounding_refs:[],inline_image_count:1});
  const run=await runs.create(env.DB,campaign.id);await runs.setState(env.DB,run.id,"ready");
  let article=await articles.create(env.DB,{run_id:run.id,title:"A practical pilot",body_html:`<p>${source}</p>`,excerpt:"A practical pilot",slug:"pilot",meta_desc:"A practical pilot",key_phrases:"[]",png_r2_key:null,output_format:"html"});
  const svg=renderSvgDiagram(diagram,"A practical pilot process"),{width,height}=pngDiagramPage(svg);
  await env.ASSETS.put(inlineKey(article.id,1,"svg"),svg,{httpMetadata:{contentType:"image/svg+xml"},customMetadata:{width:String(width),height:String(height)}});
  await articles.update(env.DB,article.id,{body_html:article.body_html+`<figure data-presskit-inline="1"><img src="${inlineUrl(article.id,1,"svg")}" width="${width}" height="${height}" alt="Pilot"></figure>`});article=(await articles.get(env.DB,article.id))!;
  const manifest:InlineManifest={version:1,baseHash:await sha256Hex(stripInline(article.body_html)),slots:[{kind:"svg" as const,sourceText:source,diagram,afterParagraph:1,alt:"Pilot",prompt:"A clear practical pilot diagram.",state:"ready" as const,attempts:1,width,height}]};
  await env.ASSETS.put(`articles/${article.id}/inline-images/manifest.json`,JSON.stringify(manifest));
  const quickAction=vi.fn(async(_action:string,options:{viewport?:{width:number;height:number};html?:string})=>new Response(png(options.viewport!.width,options.viewport!.height),{headers:{"content-type":"image/png"}}));
  const bindings={...env,DEV_AUTH_EMAIL:email,BROWSER:Object.assign({},env.BROWSER,{quickAction}),PIPELINE:{...env.PIPELINE,send:vi.fn().mockResolvedValue(undefined)}};
  return {article,run,campaign,svg,width,height,manifest,bindings,quickAction};
}
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();vi.restoreAllMocks();}});

describe("WordPress SVG to PNG conversion",()=>{
  it("plans a new diagram, saves its SVG once and publishes a converted PNG",async()=>{
    const f=await fixture();await env.ASSETS.delete(`articles/${f.article.id}/inline-images/manifest.json`);await env.ASSETS.delete(inlineKey(f.article.id,1,"svg"));
    for(const value of [{images:[{kind:"svg",afterParagraph:1,alt:"Pilot",sourceQuote:source,prompt:"A clear diagram of the practical pilot process."}]},diagram])fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST"}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(value)}]});
    expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(false);
    expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(false);expect(f.quickAction).not.toHaveBeenCalled();
    expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(false);expect(f.quickAction).toHaveBeenCalledOnce();
    expect(await inlineImageStep(f.bindings,(await articles.get(env.DB,f.article.id))!,f.campaign)).toBe(true);
    const article=(await articles.get(env.DB,f.article.id))!;expect(article.body_html).toContain(inlineUrl(article.id,1));expect(article.body_html).not.toContain(inlineUrl(article.id,1,"svg"));expect(await env.ASSETS.head(inlineKey(article.id,1,"svg"))).not.toBeNull();
  });
  it("converts the original pixels once, caches against source bytes and isolates the browser",async()=>{
    const f=await fixture(),result=await ensureInlinePng(f.bindings,f.article.id,1);expect(result.httpMetadata?.contentType).toBe("image/png");
    const bytes=new Uint8Array(await result.arrayBuffer()),view=new DataView(bytes.buffer);expect(view.getUint32(16)).toBe(f.width);expect(view.getUint32(20)).toBe(f.height);
    expect(await (await env.ASSETS.get(inlineKey(f.article.id,1,"svg")))!.text()).toBe(f.svg);
    await (await ensureInlinePng(f.bindings,f.article.id,1)).body.cancel();expect(f.quickAction).toHaveBeenCalledOnce();
    expect(f.quickAction.mock.calls[0]![0]).toBe("screenshot");expect(f.quickAction.mock.calls[0]![1]).toMatchObject({setJavaScriptEnabled:false,rejectRequestPattern:[".*"],cacheTTL:0,screenshotOptions:{type:"png",encoding:"binary"}});
    const html=f.quickAction.mock.calls[0]![1].html!;expect(html).toContain('src="data:image/svg+xml;base64,');expect(html).not.toContain("<svg");expect(html).toContain("default-src 'none'");
    expect((await articles.get(env.DB,f.article.id))?.body_html).toBe(f.article.body_html);
  });
  it("exports old drafts and stale ZIPs as PNG without rewriting prose or repeating model calls",async()=>{
    const f=await fixture();expect(await exportInlineHtml(f.bindings,f.article)).toContain("data:image/png;base64,");
    const files=unzipSync(await buildBundle(f.bindings,f.article));expect(files["inline-1.png"]).toBeTruthy();expect(files["inline-1.svg"]).toBeUndefined();expect(strFromU8(files["article.html"]!)).toContain('src="inline-1.png"');
    const key=`articles/${f.article.id}/bundle.zip`;await env.ASSETS.put(key,"old SVG bundle",{customMetadata:{bundleVersion:"before-wordpress-png"}});await articles.update(env.DB,f.article.id,{bundle_r2_key:key});
    const ctx=createExecutionContext(),response=await worker.fetch(new Request(`https://x.test/articles/${f.article.id}/bundle.zip`),f.bindings,ctx);expect(response.status).toBe(200);
    expect(unzipSync(new Uint8Array(await response.arrayBuffer()))["inline-1.svg"]).toBeUndefined();await waitOnExecutionContext(ctx);
    expect(f.quickAction).toHaveBeenCalledOnce();expect((await articles.get(env.DB,f.article.id))?.body_html).toBe(f.article.body_html);
    expect((await articles.get(env.DB,f.article.id))?.content_version).toBe(f.article.content_version);
  });
  it("serves owner-scoped PNG previews and displays legacy WordPress figures as PNG",async()=>{
    const f=await fixture();const response=await worker.fetch(new Request(`https://x.test${inlineUrl(f.article.id,1)}`),f.bindings);expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("image/png");await response.arrayBuffer();
    const page=await worker.fetch(new Request(`https://x.test/runs/${f.run.id}`),f.bindings);expect(await page.text()).toContain(`src="${inlineUrl(f.article.id,1)}"`);
    const other={...f.bindings,DEV_AUTH_EMAIL:`other-${crypto.randomUUID()}@example.com`};expect((await worker.fetch(new Request(`https://x.test${inlineUrl(f.article.id,1)}`),other)).status).toBe(404);expect(f.quickAction).toHaveBeenCalledOnce();
    const original=await worker.fetch(new Request(`https://x.test${inlineUrl(f.article.id,1,"svg")}`),f.bindings);expect(original.headers.get("content-type")).toBe("image/svg+xml");
    expect(wordpressInlineHtml({...f.article,output_format:"markdown"})).toBe(f.article.body_html);
  });
  it("leaves a specific retry response and retains the original on browser failure",async()=>{
    const f=await fixture();f.quickAction.mockImplementation(async()=>new Response("unavailable",{status:503}));
    const response=await worker.fetch(new Request(`https://x.test${inlineUrl(f.article.id,1)}`),f.bindings);expect(response.status).toBe(503);expect(response.headers.get("retry-after")).toBe("3");expect(await response.text()).toContain("original diagram and article are kept");
    expect(await env.ASSETS.head(inlineKey(f.article.id,1,"svg"))).not.toBeNull();expect(await env.ASSETS.head(inlineKey(f.article.id,1))).toBeNull();
  });
  it("rejects invalid MIME, PNG payloads, dimensions and oversized responses",async()=>{
    const f=await fixture();
    for(const response of [new Response("not an image",{headers:{"content-type":"application/json"}}),new Response("not a PNG",{headers:{"content-type":"image/png"}}),new Response(png(1,1),{headers:{"content-type":"image/png"}}),new Response("x",{headers:{"content-type":"image/png","content-length":"6000001"}})]){
      f.quickAction.mockImplementation(async()=>response);await expect(ensureInlinePng(f.bindings,f.article.id,1)).rejects.toBeInstanceOf(PngConversionError);
    }
    expect(await env.ASSETS.head(inlineKey(f.article.id,1))).toBeNull();expect(()=>pngDiagramPage('<svg width="9000" height="9000"></svg>')).toThrow("dimensions");
  });
  it("rejects truncated and damaged rasters even when their PNG header has correct dimensions",async()=>{
    const f=await fixture(),valid=png(f.width,f.height),corrupt=valid.slice();corrupt[45]=corrupt[45]!^1;
    for(const bytes of [valid.subarray(0,33),valid.subarray(0,valid.length-12),corrupt,png(f.width,f.height,new Uint8Array((f.height/2)*(f.width*3+1))),png(f.width,f.height,undefined,true)]){
      f.quickAction.mockImplementation(async()=>new Response(bytes,{headers:{"content-type":"image/png"}}));
      await expect(ensureInlinePng(f.bindings,f.article.id,1)).rejects.toBeInstanceOf(PngConversionError);
      expect(await env.ASSETS.head(inlineKey(f.article.id,1))).toBeNull();
    }
  });
  it("copies streamed chunks before a producer can reuse their backing buffer",async()=>{
    const f=await fixture(),bytes=png(f.width,f.height),buffer=new Uint8Array(64);let offset=0;
    f.quickAction.mockImplementation(async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){
      if(offset===bytes.length){controller.close();return;}
      buffer.fill(0);const part=bytes.subarray(offset,offset+buffer.length);buffer.set(part);offset+=part.length;controller.enqueue(buffer.subarray(0,part.length));
    }},{highWaterMark:0}),{headers:{"content-type":"image/png"}}));
    const result=await ensureInlinePng(f.bindings,f.article.id,1);expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
  });
  it("rebuilds legacy PNG caches and ZIPs from the intact SVG without changing the draft",async()=>{
    const f=await fixture(),bad=png(f.width,f.height).slice();bad[45]=bad[45]!^1;
    await env.ASSETS.put(inlineKey(f.article.id,1),bad,{httpMetadata:{contentType:"image/png"},customMetadata:{sourceHash:await sha256Hex(f.svg),convertedFrom:"svg"}});
    const key=`articles/${f.article.id}/bundle.zip`;
    await env.ASSETS.put(key,"cached damaged bundle",{customMetadata:{bundleVersion:"wordpress-inline-png-2026-10-28.1"}});await articles.update(env.DB,f.article.id,{bundle_r2_key:key});
    const ctx=createExecutionContext(),response=await worker.fetch(new Request(`https://x.test/articles/${f.article.id}/bundle.zip`),f.bindings,ctx);
    expect(response.status).toBe(200);const files=unzipSync(new Uint8Array(await response.arrayBuffer()));expect(inspectPng(files["inline-1.png"]!)).toEqual({width:f.width,height:f.height});await waitOnExecutionContext(ctx);
    const preview=await worker.fetch(new Request(`https://x.test${inlineUrl(f.article.id,1)}`),f.bindings);expect(inspectPng(new Uint8Array(await preview.arrayBuffer()))).toEqual({width:f.width,height:f.height});
    expect(f.quickAction).toHaveBeenCalledOnce();expect((await articles.get(env.DB,f.article.id))?.body_html).toBe(f.article.body_html);expect(await (await env.ASSETS.get(inlineKey(f.article.id,1,"svg")))!.text()).toBe(f.svg);
  });
  it("validates full scanlines and bounds decompression to declared dimensions",()=>{
    expect(inspectPng(png(3,2))).toEqual({width:3,height:2});
    for(const raster of [new Uint8Array(9),new Uint8Array(1000000),new Uint8Array([5,0,0,0])])expect(()=>inspectPng(png(1,1,raster))).toThrow();
    expect(()=>inspectPng(png(1,1,undefined,true))).toThrow();
  });
  it("shares a conversion lease instead of billing concurrent requests twice",async()=>{
    const f=await fixture();let release!:(r:Response)=>void,started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);
    f.quickAction.mockImplementation(()=>new Promise<Response>(resolve=>{release=resolve;started();}));
    const first=ensureInlinePng(f.bindings,f.article.id,1);await entered;await expect(ensureInlinePng(f.bindings,f.article.id,1)).rejects.toBeInstanceOf(PngConversionBusyError);
    release(new Response(png(f.width,f.height),{headers:{"content-type":"image/png"}}));await (await first).body.cancel();await (await ensureInlinePng(f.bindings,f.article.id,1)).body.cancel();expect(f.quickAction).toHaveBeenCalledOnce();
  });
  it("finishes a pending WordPress diagram as PNG and recovers an interrupted successful conversion",async()=>{
    const f=await fixture();await (await ensureInlinePng(f.bindings,f.article.id,1)).body.cancel();
    for (const interruptedCount of [3,4,5]) {
      f.manifest.slots[0]!.state="pending";f.manifest.slots[0]!.rasterAttempts=interruptedCount;await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`,JSON.stringify(f.manifest));
      expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(false);const saved=(await loadInline(f.bindings,f.article.id))!;expect(saved.slots[0]?.state).toBe("ready");expect(saved.slots[0]?.rasterAttempts).toBe(4);
    }
    expect(await inlineImageStep(f.bindings,(await articles.get(env.DB,f.article.id))!,f.campaign)).toBe(true);expect((await articles.get(env.DB,f.article.id))?.body_html).toContain(inlineUrl(f.article.id,1));expect(f.quickAction).toHaveBeenCalledOnce();
  });
  it("bounds new-generation conversion failures while preserving the article",async()=>{
    const f=await fixture();f.manifest.slots[0]!.state="pending";await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`,JSON.stringify(f.manifest));f.quickAction.mockImplementation(async()=>new Response("unavailable",{status:503}));
    for(let n=0;n<2;n++)await expect(inlineImageStep(f.bindings,f.article,f.campaign)).rejects.toBeInstanceOf(PngConversionError);
    expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(false);expect((await loadInline(f.bindings,f.article.id))?.slots[0]?.state).toBe("failed");expect(f.quickAction).toHaveBeenCalledTimes(3);
    expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(true);expect((await articles.get(env.DB,f.article.id))?.body_html).toContain(source);
  });
});
