import{afterEach,beforeEach,describe,expect,it}from"vitest";
import{env}from"cloudflare:test";
import{fetchMock}from"./network";
import{users,campaigns,runs,articles}from"../src/db/repos";
import{inlineImageStep,loadInline}from"../src/images/inline";

const fact="A team prepares a pilot and reviews the next practical step.";
function plan(){return {images:[1,2,3].map(afterParagraph=>({kind:"svg",afterParagraph,alt:"A practical pilot",sourceQuote:fact,prompt:"A process diagram with connected boxes showing the practical pilot steps."}))};}
async function fixture(direction=""){
 const user=await users.upsertByEmail(env.DB,"direction@example.com"),campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Help a team prepare",grounding_refs:[],inline_image_count:3,image_brief:direction}),run=await runs.create(env.DB,campaign.id),article=await articles.create(env.DB,{run_id:run.id,title:"Preparing together",body_html:`<p>${fact}</p>`.repeat(3),excerpt:fact,slug:"preparing",meta_desc:fact,key_phrases:"[]",png_r2_key:null,output_format:"html"});return{campaign,article};
}
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();}});

describe("specific and varied inline art direction",()=>{
 it("replaces repeated diagram plans with editorial scenes while preserving source placements",async()=>{
  const f=await fixture();fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST",body:body=>String(body).includes("by default")&&String(body).includes("human work moment")&&String(body).includes("Do not turn every paragraph into a workflow")}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(plan())}]});
  await inlineImageStep(env,f.article,f.campaign);const saved=(await loadInline(env,f.article.id))!;expect(saved.slots.map(s=>s.kind)).toEqual(["svg","png","png"]);expect(saved.slots.map(s=>s.afterParagraph)).toEqual([1,2,3]);expect(saved.slots[1]?.prompt).toContain(fact);expect(saved.slots[1]?.prompt).toContain("work moment");
  saved.slots[0]!.state="failed";await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`,JSON.stringify(saved));
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/generations",method:"POST",body:body=>{const r=JSON.parse(String(body));return r.output_format==="png"&&r.prompt.includes("specific relatable subject")&&r.prompt.includes("purposeful moment")&&r.prompt.includes("documentary evidence");}}).reply(200,{data:[{b64_json:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII="}]});
  await inlineImageStep(env,f.article,f.campaign);expect((await loadInline(env,f.article.id))?.slots[1]?.state).toBe("ready");
 });
 it("respects an explicit Diagrams only direction",async()=>{
  const f=await fixture("Diagrams only");fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST"}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(plan())}]});
  await inlineImageStep(env,f.article,f.campaign);expect((await loadInline(env,f.article.id))?.slots.map(s=>s.kind)).toEqual(["svg","svg","svg"]);
 });
 it("keeps a relevant GIF after an extra SVG motion proposal becomes an editorial scene",async()=>{
  const f=await fixture(),value=plan();value.images[1]!.kind="svg_motion";value.images[2]!.kind="gif";
  fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST"}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(value)}]});
  await inlineImageStep(env,f.article,f.campaign);expect((await loadInline(env,f.article.id))?.slots.map(s=>s.kind)).toEqual(["svg","png","gif"]);
 });
});
