import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:test";
import {unzipSync,strFromU8} from "fflate";
import {fetchMock} from "./network";
import {png} from "./png-fixture";
import worker from "../src/index";
import {users,campaigns,runs,articles} from "../src/db/repos";
import {renderSvgDiagram,staticSvgDiagram} from "../src/images/svg";
import {pngDiagramPage} from "../src/images/svg-png";
import {inlineImageStep,loadInline,inlineKey,inlineUrl} from "../src/images/inline";
import {buildBundle} from "../src/bundle/export";

const source="Assess the network, then run a pilot, and review the results.";
const diagram={layout:"flow" as const,palette:"teal" as const,nodes:[{label:"Assess the network",detail:"",sourceQuote:source},{label:"run a pilot",detail:"",sourceQuote:source},{label:"review the results",detail:"",sourceQuote:source}]};
const illustration={kind:"svg_motion",afterParagraph:1,alt:"A practical pilot process",sourceQuote:source,prompt:"A grounded process diagram with gentle focus highlights for each practical step."};
function reply(value:unknown,body?:(s:string)=>boolean){fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST",...(body?{body}:{})}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(value)}]});}
async function fixture(format="html",count=1,direction=""){
 const user=await users.upsertByEmail(env.DB,`svg-motion-${crypto.randomUUID()}@example.com`),campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Explain a practical pilot",grounding_refs:[],inline_image_count:count,image_brief:direction}),run=await runs.create(env.DB,campaign.id);
 const article=await articles.create(env.DB,{run_id:run.id,title:"A practical pilot",body_html:`<p>${source}</p><p>${source}</p>`,excerpt:source,slug:"pilot",meta_desc:source,key_phrases:"[]",png_r2_key:null,output_format:format});
 const quickAction=vi.fn(async(_action:string,options:{viewport?:{width:number;height:number};html?:string})=>new Response(png(options.viewport!.width,options.viewport!.height),{headers:{"content-type":"image/png"}}));
 return{article,run,campaign,quickAction,bindings:{...env,DEV_AUTH_EMAIL:user.email,BROWSER:Object.assign({},env.BROWSER,{quickAction}),PIPELINE:{...env.PIPELINE,send:vi.fn().mockResolvedValue(undefined)}}};
}
async function generateSvg(f:Awaited<ReturnType<typeof fixture>>){reply({images:[illustration]},s=>s.includes("svg_motion")&&s.includes("editable"));await inlineImageStep(f.bindings,f.article,f.campaign);reply(diagram);await inlineImageStep(f.bindings,f.article,f.campaign);if(f.article.output_format==="html")await inlineImageStep(f.bindings,f.article,f.campaign);await inlineImageStep(f.bindings,f.article,f.campaign);return(await articles.get(env.DB,f.article.id))!;}
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();vi.restoreAllMocks();}});

describe("editable static and animated SVGs",()=>{
 it("adds bounded declarative highlights while preserving exact sourced labels and static geometry",()=>{
  const still=renderSvgDiagram(diagram,"Pilot"),moving=renderSvgDiagram(diagram,"Pilot",true),normal=(s:string)=>s.replace(/>\s+</g,"><");
  expect(normal(staticSvgDiagram(moving))).toBe(normal(still));expect(still).not.toContain("<animate");
  expect(moving.match(/<animate /g)).toHaveLength(3);expect(moving).toContain('repeatCount="2"');expect(moving).toContain("prefers-reduced-motion: reduce");
  expect(moving).not.toMatch(/<script|foreignObject|<image\b|\bhref=|indefinite/);expect(moving).toContain("Assess the network");
  const attack=renderSvgDiagram(diagram,'</title><script>alert(1)</script><style>',true);expect(attack).not.toContain("<script>");expect(attack).toContain("&lt;script&gt;");
 });
 it("converts a motion SVG into the complete static diagram without timing a screenshot",()=>{
  const svg=renderSvgDiagram(diagram,"Pilot",true),{html,width,height}=pngDiagramPage(svg),data=/base64,([^\"]+)/.exec(html)![1]!;
  const still=atob(data);expect(still).not.toContain("<animate");expect(still).not.toContain("pk-vector-motion");expect(still).toContain("Assess the network");expect(width).toBe(1200);expect(height).toBeGreaterThan(0);
 });
 it("keeps the editable animated SVG downloadable while WordPress previews, copies and ZIPs use PNG",async()=>{
  const f=await fixture(),article=await generateSvg(f),manifest=(await loadInline(f.bindings,article.id))!;expect(manifest.slots[0]).toMatchObject({kind:"svg",motion:true,state:"ready"});
  expect(article.body_html).toContain(inlineUrl(article.id,1,"png"));expect(article.body_html).not.toContain(".svg");
  const svg=await(await env.ASSETS.get(inlineKey(article.id,1,"svg")))!.text();expect(svg).toContain("<animate");
  const files=unzipSync(await buildBundle(f.bindings,article));expect(files["inline-1.svg"]).toBeUndefined();expect(files["inline-1.png"]).toBeTruthy();
  const original=await worker.fetch(new Request(`https://x.test${inlineUrl(article.id,1,"svg")}`),f.bindings);expect(original.headers.get("content-type")).toBe("image/svg+xml");expect(original.headers.get("content-security-policy")).toContain("style-src 'unsafe-inline'");expect(original.headers.get("content-security-policy")).toContain("sandbox");expect(await original.text()).toContain("<animate");
  await runs.setState(env.DB,f.run.id,"ready");const page=await worker.fetch(new Request(`https://x.test/runs/${f.run.id}`),f.bindings);const html=await page.text();expect(html).toContain("Play SVG 1");expect(html).toContain("Editable SVG");expect(f.quickAction).toHaveBeenCalledOnce();
 });
 it("exports animated SVG for Markdown and lazily caches a PNG download without another model call",async()=>{
  const f=await fixture("markdown"),article=await generateSvg(f);expect(f.quickAction).not.toHaveBeenCalled();
  const files=unzipSync(await buildBundle(f.bindings,article));expect(strFromU8(files["inline-1.svg"]!)).toContain("<animate");expect(strFromU8(files["article.md"]!)).toContain("inline-1.svg");
  const request=new Request(`https://x.test${inlineUrl(article.id,1,"png")}`),first=await worker.fetch(request,f.bindings);expect(first.status).toBe(200);expect(first.headers.get("content-type")).toBe("image/png");await first.arrayBuffer();
  await(await worker.fetch(request,f.bindings)).arrayBuffer();expect(f.quickAction).toHaveBeenCalledOnce();
  expect(await(await env.ASSETS.get(inlineKey(article.id,1,"svg")))!.text()).toContain("<animate");
 });
 it("shares the single motion allowance across GIF and SVG and preserves still-only preferences",async()=>{
  const f=await fixture("html",2);reply({images:[illustration,{...illustration,kind:"gif",afterParagraph:2}]});await inlineImageStep(f.bindings,f.article,f.campaign);const slots=(await loadInline(f.bindings,f.article.id))!.slots;expect(slots[0]).toMatchObject({kind:"svg",motion:true});expect(slots[1]?.kind).toBe("png");
  const still=await fixture("html",1,"Still images only");reply({images:[{...illustration,kind:"svg"}]},s=>{const kinds=JSON.parse(s).output_config.format.schema.properties.images.items.properties.kind.enum;return kinds.includes("svg")&&!kinds.includes("svg_motion")&&!kinds.includes("gif");});await inlineImageStep(still.bindings,still.article,still.campaign);expect((await loadInline(still.bindings,still.article.id))!.slots[0]?.motion).toBeUndefined();
 });
 it("keeps Word and email on compatible formats and rejects malformed motion checkpoints",async()=>{
  for(const format of["word","email"]){const f=await fixture(format);reply({images:[{...illustration,kind:"png"}]},s=>!JSON.parse(s).output_config.format.schema.properties.images.items.properties.kind.enum.includes("svg_motion"));await inlineImageStep(f.bindings,f.article,f.campaign);}
  const f=await fixture();await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`,JSON.stringify({version:1,baseHash:"fixture",slots:[{...illustration,kind:"png",motion:true,attempts:0,state:"pending"}]}));await expect(loadInline(f.bindings,f.article.id)).rejects.toThrow("motion checkpoint");
 });
});
