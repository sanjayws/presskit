import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:test";
import {unzipSync,strFromU8,unzlibSync} from "fflate";
import {fetchMock} from "./network";
import {motionFixture} from "./gif-fixture";
import worker from "../src/index";
import {users,campaigns,runs,articles} from "../src/db/repos";
import {base64ToBytes,generateMotionImage} from "../src/openai/image";
import {prepareMotion,InvalidMotionError,motionDisabled} from "../src/images/gif";
import {inspectPng} from "../src/images/png";
import {inlineImageStep,loadInline,inlineKey,inlineUrl,motionSourceKey,exportInlineHtml,type InlineManifest} from "../src/images/inline";
import {sha256Hex} from "../src/grounding/ingest";
import {buildBundle} from "../src/bundle/export";
import {sanitizeHtml} from "../src/content/sanitize";
import {stageAutoDecide,optionJobKey,optionResultKey} from "../src/editorial/auto-decide";

const fact="The paper room unfolds to connect three workspaces.",png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";
const slot={kind:"gif" as const,afterParagraph:1,alt:"An illustrative room unfolding",sourceQuote:fact,prompt:"A paper room gently unfolds into connected workspaces and returns to its initial pose."};
const original=()=>base64ToBytes(motionFixture);
function opus(value:unknown,body?:(s:string)=>boolean){fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST",...(body ? {body}: {})}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(value)}]});}
function gifReply(model="gpt-image-2.6-sunburst") {fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST",body:(s)=>{const r=JSON.parse(String(s));return r.model===model && r.output_format==="gif" && r.n===1 && r.size==="512x512" && r.frame_count===9 && r.frame_duration_ms===200 && r.quality==="medium" && r.moderation==="auto" && !["stream","partial_images","output_compression","prompt_rewriter"].some(k=>k in r);}}).reply(200,{data:[{b64_json:motionFixture}]});}
async function fixture(format="html",count=1,direction=""){
 const user=await users.upsertByEmail(env.DB,`motion-${crypto.randomUUID()}@example.com`),campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Explain connected workspaces",grounding_refs:[],inline_image_count:count,image_brief:direction}),run=await runs.create(env.DB,campaign.id);
 const article=await articles.create(env.DB,{run_id:run.id,title:"Connected workspaces",body_html:`<p>${fact}</p><p>${fact}</p>`,excerpt:fact,slug:"workspaces",meta_desc:fact,key_phrases:"[]",png_r2_key:null,output_format:format});
 return {user,campaign,run,article,bindings:{...env,DEV_AUTH_EMAIL:user.email,PIPELINE:{...env.PIPELINE,send:vi.fn().mockResolvedValue(undefined)}}};
}
async function pending(f:Awaited<ReturnType<typeof fixture>>,attempts=0){const manifest:InlineManifest={version:1,baseHash:await sha256Hex(f.article.body_html),slots:[{...slot,state:"pending",attempts}]};await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`,JSON.stringify(manifest));}
async function finish(f:Awaited<ReturnType<typeof fixture>>){await inlineImageStep(f.bindings,f.article,f.campaign);await inlineImageStep(f.bindings,f.article,f.campaign);return (await articles.get(env.DB,f.article.id))!;}
function pngRows(bytes:Uint8Array){const parts:Uint8Array[]=[];const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let p=8;p+12<=bytes.length;){const n=view.getUint32(p);if(new TextDecoder().decode(bytes.subarray(p+4,p+8))==="IDAT")parts.push(bytes.subarray(p+8,p+8+n));p+=n+12;}const b=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){b.set(p,at);at+=p.length;}return unzlibSync(b);}
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();vi.restoreAllMocks();}});

describe("bounded generated motion",()=>{
 it("validates every GIF frame, creates an exact first-frame PNG and limits playback without changing the original",()=>{
  const source=original(),before=source.slice(),r=prepareMotion(source);expect(r.frames).toBe(3);expect(inspectPng(r.poster)).toEqual({width:16,height:16});expect(source).toEqual(before);
  const text=new TextDecoder("latin1").decode(r.bytes);expect(text).toContain("NETSCAPE2.0");const p=text.indexOf("NETSCAPE2.0");expect(Array.from(r.bytes.subarray(p+11,p+16))).toEqual([3,1,1,0,0]);
  const rows=pngRows(r.poster),palette=[[0,0,0,255],[240,120,30,255],[30,180,210,255],[255,255,255,255]];
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)expect(Array.from(rows.subarray(y*65+1+x*4,y*65+5+x*4))).toEqual(palette[(Math.floor(x/2)+Math.floor(y/2))%4]);
 });
 it("rejects truncated data, malformed LZW and invalid frame bounds before saving an image",()=>{
  const valid=original(),wide=valid.slice();wide[6]=1;wide[7]=3;
  const broken=valid.slice(),lzw=valid.slice();const image=broken.indexOf(44,25);if(image<0)throw new Error("Invalid synthetic fixture");broken[image+5]=255;lzw[image+10]=1;
  let end=image+11;while(valid[end])end+=1+valid[end]!;end++;
  const repeated=new Uint8Array([...valid.subarray(0,25),...Array.from({length:10},()=>Array.from(valid.subarray(image,end))).flat(),59]);
  for(const bytes of [new Uint8Array(),valid.subarray(0,13),valid.subarray(0,valid.length-1),valid.subarray(0,80),wide,new Uint8Array([...valid,0]),broken,lzw,repeated])expect(()=>prepareMotion(bytes)).toThrow(InvalidMotionError);
 });
 it.each(["gpt-image-2.6-sunburst","gpt-image-2.6-flare"])("requests a bounded GIF through %s",async(model)=>{gifReply(model);const r=await generateMotionImage({...env,OPENAI_IMAGE_MODEL:model},"A paper room gently unfolding");expect(r.frames).toBe(3);expect(r.original).toEqual(original());});
 it("plans motion only where meaningful and delivers private GIF/PNG assets in previews, copies and ZIPs",async()=>{
  const f=await fixture();opus({images:[slot]},s=>s.includes("motion adds meaning")&&s.includes("first frame")&&s.includes('"gif"'));
  expect(await inlineImageStep(f.bindings,f.article,f.campaign)).toBe(false);gifReply();const article=await finish(f);
  expect(article.body_html).toContain("<picture>");expect(article.body_html).toContain("prefers-reduced-motion: reduce");expect(article.body_html).toContain(inlineUrl(article.id,1,"gif"));
  const html=await exportInlineHtml(f.bindings,article);expect(html).toContain("data:image/gif;base64,");expect(html).toContain('srcset="data:image/png;base64,');expect(html).not.toContain(`/articles/${article.id}/`);
  const files=unzipSync(await buildBundle(f.bindings,article));expect(files["inline-1.gif"]).toBeTruthy();expect(inspectPng(files["inline-1.png"]!)).toEqual({width:16,height:16});expect(strFromU8(files["article.html"]!)).toContain('srcset="inline-1.png"');
  expect(new Uint8Array(await (await env.ASSETS.get(motionSourceKey(article.id,1)))!.arrayBuffer())).toEqual(original());
  const response=await worker.fetch(new Request(`https://x.test${inlineUrl(article.id,1,"gif")}`),f.bindings);expect(response.headers.get("content-type")).toBe("image/gif");await response.arrayBuffer();
  expect((await worker.fetch(new Request(`https://x.test${inlineUrl(article.id,1,"gif")}`), {...f.bindings, DEV_AUTH_EMAIL:"other-motion@example.com"})).status).toBe(404);
  expect((await worker.fetch(new Request(`https://x.test/articles/${article.id}/inline-images/1.source.gif`),f.bindings)).status).toBe(404);
  await runs.setState(env.DB,f.run.id,"ready");const page=await worker.fetch(new Request(`https://x.test/runs/${f.run.id}`),f.bindings);expect(await page.text()).toContain("Play motion 1");
  const saved=await sanitizeHtml(article.body_html,article.id);expect(saved).toContain("<picture>");expect(saved).toContain("srcset=");
  expect(await sanitizeHtml(`<picture><source media="(prefers-reduced-motion: reduce)" srcset="https://tracker.example/pixel"><img src="/articles/other/inline-images/1.gif" onerror="alert(1)"></picture>`,article.id)).not.toMatch(/source|<img/);
 });
 it.each(["email","markdown"])("exports portable GIF motion for %s",async(format)=>{
  const f=await fixture(format);await pending(f);gifReply();const article=await finish(f);const files=unzipSync(await buildBundle(f.bindings,article));expect(files["inline-1.gif"]).toBeTruthy();
  expect(strFromU8(files[format==="markdown"?"article.md":"article.html"]!)).toContain("inline-1.gif");
 });
 it("uses the saved first frame for Word and gives a specific error if a saved motion asset is missing",async()=>{
  const f=await fixture();await pending(f);gifReply();const article=await finish(f);
  const word={...article,output_format:"word"};const files=unzipSync(await buildBundle(f.bindings,word));expect(files["inline-1.gif"]).toBeUndefined();expect(files["inline-1.png"]).toBeTruthy();expect(strFromU8(files["article.doc"]!)).not.toContain(".gif");
  await env.ASSETS.delete(inlineKey(article.id,1,"gif"));await expect(buildBundle(f.bindings,article)).rejects.toThrow("motion image is unavailable");
 });
 it.each([["word",""],["html","Still images only"],["html","No GIFs"]])("keeps %s with '%s' static",async(format,direction)=>{
  const f=await fixture(format,1,direction);opus({images:[{...slot,kind:"png"}]},s=>!JSON.parse(s).output_config.format.schema.properties.images.items.properties.kind.enum.includes("gif"));await inlineImageStep(f.bindings,f.article,f.campaign);expect((await loadInline(f.bindings,f.article.id))?.slots[0]?.kind).toBe("png");
 });
 it("limits GIFs to one per output and disables them for older model overrides",async()=>{
  const f=await fixture("html",2);opus({images:[slot,{...slot,afterParagraph:2}]});await inlineImageStep(f.bindings,f.article,f.campaign);expect((await loadInline(f.bindings,f.article.id))?.slots.map(s=>s.kind)).toEqual(["gif","png"]);
  const older=await fixture();opus({images:[{...slot,kind:"png"}]},s=>!JSON.parse(s).output_config.format.schema.properties.images.items.properties.kind.enum.includes("gif"));await inlineImageStep({...older.bindings,OPENAI_IMAGE_MODEL:"gpt-image-2"},older.article,older.campaign);
  expect(motionDisabled("Still images only")).toBe(true);
 });
 it("recovers after only the original GIF was saved without another paid call",async()=>{
  const f=await fixture();await pending(f,3);await env.ASSETS.put(motionSourceKey(f.article.id,1),original());const article=await finish(f);expect(article.body_html).toContain(".gif");expect((await loadInline(f.bindings,article.id))?.slots[0]?.attempts).toBe(3);
 });
 it("uses a still after invalid GIF data and stays within the three-call budget",async()=>{
  const f=await fixture();await pending(f);fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST"}).reply(200,{data:[{b64_json:btoa("GIF89a broken")} ]});
  await inlineImageStep(f.bindings,f.article,f.campaign);expect((await loadInline(f.bindings,f.article.id))?.slots[0]?.kind).toBe("png");
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST",body:s=>JSON.parse(String(s)).output_format==="png"}).reply(200,{data:[{b64_json:png}]});
  const article=await finish(f);expect(article.body_html).toContain(".png");expect((await loadInline(f.bindings,article.id))?.slots[0]?.attempts).toBe(2);
 });
 it("switches to a still when the provider rejects GIF-specific settings",async()=>{
  const f=await fixture();await pending(f);fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST"}).reply(400,{error:{code:"unsupported_output_format",param:"output_format"}});
  await inlineImageStep(f.bindings,f.article,f.campaign);expect((await loadInline(f.bindings,f.article.id))?.slots[0]).toMatchObject({kind:"png",state:"pending",attempts:1});
 });
 it("falls back after two transient GIF attempts, while moderation and quota failures stop without further calls",async()=>{
  const f=await fixture();await pending(f);
  for(let n=0;n<2;n++){fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST"}).reply(503,{});if(!n)await expect(inlineImageStep(f.bindings,f.article,f.campaign)).rejects.toThrow();else await inlineImageStep(f.bindings,f.article,f.campaign);}
  expect((await loadInline(f.bindings,f.article.id))?.slots[0]).toMatchObject({kind:"png",attempts:2,state:"pending"});
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST"}).reply(200,{data:[{b64_json:png}]});await finish(f);expect((await loadInline(f.bindings,f.article.id))?.slots[0]?.attempts).toBe(3);
  for(const [status,code]of [[400,"moderation_blocked"],[429,"insufficient_quota"]]as const){const blocked=await fixture();await pending(blocked);fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST"}).reply(status,{error:{code}});await inlineImageStep(blocked.bindings,blocked.article,blocked.campaign);expect((await loadInline(blocked.bindings,blocked.article.id))?.slots[0]).toMatchObject({state:"failed",attempts:1});}
 });
 it("keeps an interrupted motion checkpoint recoverable when storage is unavailable",async()=>{
  const f=await fixture();await pending(f);gifReply();const put=env.ASSETS.put.bind(env.ASSETS);vi.spyOn(env.ASSETS,"put").mockImplementation(async(...args:Parameters<typeof env.ASSETS.put>)=>{if(String(args[0]).endsWith("/1.gif"))throw new Error("R2 PUT temporarily unavailable");return put(...args);});
  await expect(inlineImageStep(f.bindings,f.article,f.campaign)).rejects.toThrow();vi.restoreAllMocks();await finish(f);expect((await loadInline(f.bindings,f.article.id))?.slots[0]).toMatchObject({kind:"gif",state:"ready",attempts:1});
 });
 it("preserves explicit still-only direction through Auto decide",async()=>{
  const f=await fixture(),id=`opt_${crypto.randomUUID()}`;await env.DB.prepare("INSERT INTO brief_option_jobs(id,user_id,created_at) VALUES(?,?,?)").bind(id,f.user.id,Date.now()).run();
  await env.ASSETS.put(optionJobKey(id),JSON.stringify({fields:{idea:fact,image_brief:"Still images only"},urls:[],text:fact,read:0,uploadDone:true,warnings:[]}));
  opus({reason:"A grounded visual explains the process.",article_type:"article",output_format:"html",output_formats:["html"],persona:"professional",tone:"professional",temperature:.6,max_words:500,image_style:"editorial",inline_image_count:1,image_brief:"A useful paper sculpture."});
  await stageAutoDecide(f.bindings,id);const result=await (await env.ASSETS.get(optionResultKey(id)))!.json<{suggestions:{image_brief:string}}>();expect(result.suggestions.image_brief).toContain("Still images only");
 });
});
