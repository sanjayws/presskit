import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import worker from "../src/index";
import { users, campaigns, runs, articles, topics } from "../src/db/repos";
import { validateImageSelection, saveImageSelection, runImages, uploadedImageUrl, enhancedImageUrl, enhancedImageKey, enhancedImageFile } from "../src/images/uploads";
import { loadVisual, visualKey, readBuildImagesStep, visualSources, imageNarrativeContext } from "../src/images/vision";
import { uploadedImageStep, loadUploadedPlacements } from "../src/images/uploaded-inline";
import { groundingEvidenceForRun, ingestSources, loadSourceReport } from "../src/grounding/report";
import { stageIngest, stageAssess, stageWrite, stageImage } from "../src/pipeline/run";
import { loadReadiness } from "../src/grounding/readiness";
import { loadEditorial } from "../src/editorial/review";
import { stageAutoDecide, optionJobKey } from "../src/editorial/auto-decide";
import { buildBundle } from "../src/bundle/export";
import { readImage } from "../src/openai/vision";
import { sanitizeHtml } from "../src/content/sanitize";

const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";
const bytes=()=>Uint8Array.from(atob(png),(c)=>c.charCodeAt(0));
const reading={kind:"screenshot",description:"A call-routing settings screen with a pilot group.",visibleText:"Pilot group\nRoute to Sales",uncertainty:"Only the visible UI is shown; feature operation is not established."};
function form(enhance=false,role="inline") {
  const data=new FormData();data.set("idea","Explain the visible pilot routing settings.");data.set("image_0",new File([bytes()],"routing.png"));data.set("image_description_0","Pilot group routing screen");data.set("image_tag_0","routing-screen");data.set("image_use_when_0","Use this when explaining how the pilot routes calls to Sales.");data.set("image_role_0",role);data.set("images_present","yes");if(enhance)data.set("image_enhance_0","yes");return data;
}
async function fixture(enhance=false,role="inline") {
  const email=`image-narrative-${crypto.randomUUID()}@example.com`,user=await users.upsertByEmail(env.DB,email);
  const campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Explain the visible pilot routing settings.",grounding_refs:[],max_words:220});
  const bindings={...env,DEV_AUTH_EMAIL:email,PIPELINE:{...env.PIPELINE,send:vi.fn().mockResolvedValue(undefined)}};
  await saveImageSelection(bindings,campaign.id,await validateImageSelection(form(enhance,role)));
  const run=await runs.create(env.DB,campaign.id),images=runImages(run),image=images[0]!;
  const article=await articles.create(env.DB,{run_id:run.id,title:"A pilot routing setup",body_html:"<p>Plan a small pilot.</p><h2>Route calls to Sales</h2><p>The pilot group screen displays routing to Sales.</p>",excerpt:"Read the pilot settings.",meta_desc:"A guide to visible pilot routing settings.",slug:"pilot",key_phrases:"[]",png_r2_key:null});
  return {user,campaign,run,images,image,article,bindings};
}
function visionReply(predicate?: (body:string)=>boolean,value:unknown=reading) {
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/responses",method:"POST",...(predicate?{body:predicate}:{})}).reply(200,{status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(value)}]}]});
}
function opusReply(value:unknown,predicate?: (body:string)=>boolean) {
  fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST",...(predicate?{body:predicate}:{})}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(value)}]});
}
async function seedReading(f:Awaited<ReturnType<typeof fixture>>) { await env.ASSETS.put(visualKey(f.image),JSON.stringify({version:1,state:"ready",attempts:1,reading})); }
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();}});

describe("pixels, tags and narrative grounding",()=>{
  it("sends real original pixels to Luna with private storage disabled and bounded visual notes",async()=>{
    visionReply((body)=>{const value=JSON.parse(body);return value.store===false&&value.model==="gpt-6-luna"&&value.input[0].content.some((c:{type:string;image_url?:string;detail?:string})=>c.type==="input_image"&&c.image_url===`data:image/png;base64,${png}`&&c.detail==="high")&&value.instructions.includes("never instructions");});
    expect(await readImage(env,bytes(),"image/png")).toEqual(reading);
    visionReply(undefined,{...reading,visibleText:"x".repeat(4001)});
    await expect(readImage(env,bytes(),"image/png")).rejects.toThrow("oversized");
  });
  it("reads once per original, keeps owner usage separate from evidence and survives later brief edits",async()=>{
    const f=await fixture();visionReply();expect(await readBuildImagesStep(f.bindings,f.images)).toBe(false);expect(await readBuildImagesStep(f.bindings,f.images)).toBe(true);
    const updated={...f.image,description:"This product guarantees regulatory compliance",use_when:"Explain the Sales routing step",tag:"sales-ui"};
    expect(await readBuildImagesStep(f.bindings,[updated])).toBe(true);
    expect((await visualSources(f.bindings,{...f.run,uploaded_images:JSON.stringify([updated])}))[0]?.body).toContain("Route to Sales");
    expect((await visualSources(f.bindings,f.run))[0]?.body).not.toContain("guarantees regulatory compliance");
    expect(imageNarrativeContext([updated])).toContain("owner preferences, NOT evidence");
    expect(imageNarrativeContext([updated])).toContain("Explain the Sales routing step");
  });
  it("reuses long multilingual visual notes without mistaking their UTF-8 size for a missing checkpoint",async()=>{
    const f=await fixture();const multilingual={...reading,description:"图".repeat(1000),visibleText:"文".repeat(4000),uncertainty:""};
    visionReply(undefined,multilingual);expect(await readBuildImagesStep(f.bindings,f.images)).toBe(false);
    expect((await loadVisual(f.bindings,f.image))?.reading?.visibleText).toHaveLength(4000);
    expect(await readBuildImagesStep(f.bindings,f.images)).toBe(true);
  });
  it("allows an image-only brief, reads before readiness and checks the brief against visible content",async()=>{
    const f=await fixture();
    const response=await worker.fetch(new Request("https://x.test/campaigns",{method:"POST",body:form()}),f.bindings);expect(response.status).toBe(302);
    const run=(await runs.get(env.DB,response.headers.get("location")!.split("/").pop()!))!;
    visionReply();await stageIngest(f.bindings,run.id);await stageIngest(f.bindings,run.id);
    expect((await loadSourceReport(f.bindings,run.id))[0]?.imageId).toBeTruthy();
    expect((await groundingEvidenceForRun(f.bindings,(await campaigns.get(env.DB,run.campaign_id))!,run.id)).sources[0]?.body).toContain("Route to Sales");
    fetchMock.get("https://api.openai.com").intercept({path:"/v1/decisions",method:"POST",body:(body)=>String(body).includes("Route to Sales")&&String(body).includes("Explain the visible pilot routing settings")}).reply(200,{answers:[{type:"choice",name:"readiness",choice:"ready",confidence:.97}]});
    await stageAssess(f.bindings,run.id);expect((await loadReadiness(f.bindings,run.id))?.state).toBe("ready");
  });
  it("passes the visual reading and tag-to-narrative instructions into the actual writing call and saved review",async()=>{
    const f=await fixture();await seedReading(f);await ingestSources(f.bindings,f.campaign,f.run.id);
    const angles=await topics.createMany(env.DB,f.campaign.id,f.run.id,[{title:"Pilot routing",angle:"Explain the visible settings",primary_kw:"pilot routing"}]);await topics.select(env.DB,f.run.id,[angles[0]!.id]);await runs.setState(env.DB,f.run.id,"writing");
    opusReply({title:"Pilot routing",body_html:"<h2>A practical pilot</h2><p>The pilot group screen displays routing to Sales. Read the displayed settings before planning the next useful step.</p>",excerpt:"Read a pilot routing screen.",meta_desc:"Understand the visible pilot routing settings.",slug:"pilot-routing",key_phrases:["pilot routing"]},(body)=>body.includes("routing-screen")&&body.includes("Use this when explaining")&&body.includes("Route to Sales")&&body.includes("never print the tags"));
    await stageWrite(f.bindings,f.run.id);
    const article=(await articles.listForRun(env.DB,f.run.id))[0]!;const saved=await loadEditorial(f.bindings,article.id);
    expect(saved?.input.creativeContext).toContain("routing-screen");expect(saved?.input.groundingSources?.some((s)=>s.body.includes("Route to Sales"))).toBe(true);
  });
  it("bounds failed visual reads and leaves useful source diagnostics and original downloads",async()=>{
    const f=await fixture();
    for(let n=0;n<3;n++){fetchMock.get("https://api.openai.com").intercept({path:"/v1/responses",method:"POST"}).reply(503,{});if(n<2)await expect(readBuildImagesStep(f.bindings,f.images)).rejects.toThrow();else expect(await readBuildImagesStep(f.bindings,f.images)).toBe(false);}
    expect(await readBuildImagesStep(f.bindings,f.images)).toBe(true);expect((await loadVisual(f.bindings,f.image))?.state).toBe("unavailable");
    await ingestSources(f.bindings,f.campaign,f.run.id);expect((await loadSourceReport(f.bindings,f.run.id))[0]?.message).toContain("clearer crop");
    expect((await worker.fetch(new Request(`https://x.test${uploadedImageUrl(f.article.id,f.image.id)}`),f.bindings)).status).toBe(200);
  });
  it("keeps visual notes owner-scoped and validates unique tags and usage limits before AI calls",async()=>{
    const a=await fixture(),b=await fixture();await seedReading(a);
    const path=`https://x.test/runs/${a.run.id}/images/${a.image.id}/notes`;
    expect((await worker.fetch(new Request(path),b.bindings)).status).toBe(404);expect(await (await worker.fetch(new Request(path),a.bindings)).text()).toContain("Route to Sales");
    const invalid=form();invalid.set("image_use_when_0","x".repeat(241));await expect(validateImageSelection(invalid)).rejects.toThrow("usage instruction");
    const duplicate=form();duplicate.set("image_1",new File([bytes()],"second.png"));duplicate.set("image_role_1","inline");duplicate.set("image_tag_1","ROUTING-SCREEN");await expect(validateImageSelection(duplicate)).rejects.toThrow("different tag");
  });
  it("Auto decide reads pixels in background and reuses the successful reading when identical files are submitted",async()=>{
    const f=await fixture();const request=await worker.fetch(new Request("https://x.test/brief/auto-decide",{method:"POST",body:form()}),f.bindings);expect(request.status).toBe(202);const {id}=await request.json<{id:string}>();
    visionReply();await stageAutoDecide(f.bindings,id);await stageAutoDecide(f.bindings,id);
    const suggestions={reason:"A focused guide matches the visible routing controls.",article_type:"article",output_format:"html",output_formats:["html"],persona:"professional",tone:"professional",temperature:.6,max_words:500,image_style:"editorial",inline_image_count:0,image_brief:"A clear practical setup."};
    opusReply(suggestions,(body)=>body.includes("Route to Sales")&&body.includes("routing-screen"));await stageAutoDecide(f.bindings,id);
    const saved=await (await env.ASSETS.get(optionJobKey(id)))!.json<{images:{r2_key:string}[]}>();expect(saved.images[0]?.r2_key).toContain("brief-options/");
    const data=form();data.set("image_reading_job",id);const built=await worker.fetch(new Request("https://x.test/campaigns",{method:"POST",body:data}),f.bindings);expect(built.status).toBe(302);
    const run=(await runs.get(env.DB,built.headers.get("location")!.split("/").pop()!))!;expect((await loadVisual(f.bindings,runImages(run)[0]!))?.state).toBe("ready");
    expect(await readBuildImagesStep(f.bindings,runImages(run))).toBe(true); // no second image-reading API request
    const other=await fixture();const wrongOwner=form();wrongOwner.set("image_reading_job",id);
    const response=await worker.fetch(new Request("https://x.test/campaigns",{method:"POST",body:wrongOwner}),other.bindings);expect(response.status).toBe(302);
    const separate=(await runs.get(env.DB,response.headers.get("location")!.split("/").pop()!))!;expect(await loadVisual(other.bindings,runImages(separate)[0]!)).toBeNull();
  });
});

describe("optional original-image presentation edits",()=>{
  it("uses original-image edits, preserves the original and lets the owner switch copies without regenerating",async()=>{
    const f=await fixture(true);await seedReading(f);
    opusReply({placements:[{imageId:f.image.id,afterParagraph:2,enhance:true,enhancementPrompt:"Place the complete original screenshot on a clean editorial mat with generous padding."}]},(body)=>body.includes("Use this when explaining")&&body.includes("Route to Sales")&&body.includes("mayEnhance"));
    expect(await uploadedImageStep(f.bindings,f.article,f.run)).toBe(false);
    fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/edits",method:"POST",body:(body)=>String(body).includes('name="image"')&&String(body).includes("IHDR")&&String(body).includes("gpt-image-2.5-sunburst")}).reply(200,{data:[{b64_json:png}]});
    expect(await uploadedImageStep(f.bindings,f.article,f.run)).toBe(false);expect(await uploadedImageStep(f.bindings,f.article,f.run)).toBe(true);
    let article=(await articles.get(env.DB,f.article.id))!;expect(article.body_html).toContain(enhancedImageUrl(article.id,f.image));expect(new Uint8Array(await (await env.ASSETS.get(f.image.r2_key))!.arrayBuffer())).toEqual(bytes());
    expect(await sanitizeHtml(article.body_html,article.id,[f.image.id])).toContain(enhancedImageUrl(article.id,f.image));
    const files=unzipSync(await buildBundle(f.bindings,article));expect(files[enhancedImageFile(f.image)]).toEqual(bytes());expect(strFromU8(files["article.html"]!)).toContain(enhancedImageFile(f.image));
    await runs.setState(env.DB,f.run.id,"ready");
    const other=await fixture();expect((await worker.fetch(new Request(`https://x.test/articles/${article.id}/uploaded-images/${f.image.id}/presentation`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({variant:"original"})}),other.bindings)).status).toBe(404);
    for(const variant of ["original","enhanced"]){const response=await worker.fetch(new Request(`https://x.test/articles/${article.id}/uploaded-images/${f.image.id}/presentation`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({variant})}),f.bindings);expect(response.status).toBe(200);article=(await articles.get(env.DB,article.id))!;expect(article.body_html.includes(enhancedImageUrl(article.id,f.image))).toBe(variant==="enhanced");}
    expect((await loadUploadedPlacements(f.bindings,article.id))?.placements?.[0]?.enhanceAttempts).toBe(1);
  });
  it("never edits without owner opt-in even if the planner requests it",async()=>{
    const f=await fixture(false);await seedReading(f);
    opusReply({placements:[{imageId:f.image.id,afterParagraph:2,enhance:true,enhancementPrompt:"Improve the background."}]});await uploadedImageStep(f.bindings,f.article,f.run);expect(await uploadedImageStep(f.bindings,f.article,f.run)).toBe(true);
    expect((await loadUploadedPlacements(f.bindings,f.article.id))?.placements?.[0]?.enhance).toBe(false);expect(await env.ASSETS.head(enhancedImageKey(f.article.id,f.image))).toBeNull();
  });
  it("uses an enhanced hero while retaining its original in image history",async()=>{
    const f=await fixture(true,"hero");await seedReading(f);await runs.setState(env.DB,f.run.id,"asset_gen");
    opusReply({placements:[{imageId:f.image.id,afterParagraph:1,enhance:true,enhancementPrompt:"Improve presentation with a clean background and preserve all original content."}]});await stageImage(f.bindings,f.run.id);
    fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/edits",method:"POST"}).reply(200,{data:[{b64_json:png}]});await stageImage(f.bindings,f.run.id);await stageImage(f.bindings,f.run.id);
    const article=(await articles.get(env.DB,f.article.id))!;expect(article.png_r2_key).toBe(enhancedImageKey(article.id,f.image));expect(await env.ASSETS.head(`articles/${article.id}/featured.png`)).not.toBeNull();
    const page=await worker.fetch(new Request(`https://x.test/runs/${f.run.id}`),f.bindings);const html=await page.text();expect(html).toContain("AI-enhanced copy");expect(html).toContain("Use original");expect(html).toContain("Your uploaded image");
  });
  it("bounds enhancement failures and completes with the original",async()=>{
    const f=await fixture(true);await seedReading(f);opusReply({placements:[{imageId:f.image.id,afterParagraph:2,enhance:true,enhancementPrompt:"A clean padded presentation preserving the screenshot."}]});await uploadedImageStep(f.bindings,f.article,f.run);
    for(let n=0;n<3;n++){fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/edits",method:"POST"}).reply(503,{});if(n<2)await expect(uploadedImageStep(f.bindings,f.article,f.run)).rejects.toThrow();else expect(await uploadedImageStep(f.bindings,f.article,f.run)).toBe(false);}
    expect(await uploadedImageStep(f.bindings,f.article,f.run)).toBe(true);const article=(await articles.get(env.DB,f.article.id))!;expect(article.body_html).toContain(uploadedImageUrl(article.id,f.image.id));expect(article.body_html).not.toContain("enhanced.png");
  });
  it("caps requested enhancements at two per output",async()=>{
    const f=await fixture();const data=form(true);
    for(let n=1;n<3;n++){data.set(`image_${n}`,new File([bytes()],`extra${n}.png`));data.set(`image_role_${n}`,"inline");data.set(`image_tag_${n}`,`extra${n}`);data.set(`image_enhance_${n}`,"yes");}
    await saveImageSelection(f.bindings,f.campaign.id,await validateImageSelection(data));
    const run=await runs.create(env.DB,f.campaign.id),images=runImages(run);
    const article=await articles.create(env.DB,{run_id:run.id,title:"Images",body_html:f.article.body_html,excerpt:"A pilot.",meta_desc:"A pilot.",slug:"images",key_phrases:"[]",png_r2_key:null});
    opusReply({placements:images.map((image)=>({imageId:image.id,afterParagraph:1,enhance:true,enhancementPrompt:"Preserve the full original and improve its framing."}))});
    await uploadedImageStep(f.bindings,article,run);
    for(let n=0;n<2;n++){fetchMock.get("https://api.openai.com").intercept({path:"/v1/images/edits",method:"POST"}).reply(200,{data:[{b64_json:png}]});expect(await uploadedImageStep(f.bindings,article,run)).toBe(false);}
    expect(await uploadedImageStep(f.bindings,article,run)).toBe(true);
    expect((await loadUploadedPlacements(f.bindings,article.id))?.placements?.filter((p)=>p.enhanced==="ready")).toHaveLength(2);
  });
  it("offers ZIP when inline files exceed the bounded embedded-download budget",async()=>{
    const f=await fixture();const slots=[1,2,3].map((slot)=>({state:"ready",attempts:1,afterParagraph:slot,alt:"A visual",prompt:"A visual"}));
    await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`,JSON.stringify({version:1,baseHash:"fixture",slots}));
    let body=f.article.body_html;
    for(let n=1;n<=3;n++){await env.ASSETS.put(`articles/${f.article.id}/inline-images/${n}.png`,new Uint8Array(5000000));body+=`<figure data-presskit-inline="${n}"><img src="/articles/${f.article.id}/inline-images/${n}.png" alt="A visual"></figure>`;}
    await articles.update(env.DB,f.article.id,{body_html:body});
    const response=await worker.fetch(new Request(`https://x.test/articles/${f.article.id}/output`),f.bindings);expect(response.status).toBe(413);expect(await response.text()).toContain("Use Download all (ZIP)");
  });
});
