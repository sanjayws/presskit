import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { fetchMock } from "./network";
import { unzipSync, strFromU8 } from "fflate";
import worker from "../src/index";
import { users, campaigns, runs, articles, campaignForRun } from "../src/db/repos";
import { rebuildArticleBundle } from "../src/pipeline/run";
import { ingestSources, loadSourceReport } from "../src/grounding/report";
import { saveSourceUpload } from "../src/grounding/uploads";
import { saveImageSelection, validateImageSelection, runImages } from "../src/images/uploads";
import { loadVisual, visualKey, readBuildImagesStep, resetFailedVisuals } from "../src/images/vision";
import { StageBusyError } from "../src/errors";
import { stageAutoDecide, optionJobKey } from "../src/editorial/auto-decide";
import { resumeSavedRun } from "../src/pipeline/recovery";
import { uploadedPlacementKey } from "../src/images/uploaded-inline";
import { enhancedImageKey } from "../src/images/uploads";

const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";
const reading={kind:"screenshot",description:"A routing screen.",visibleText:"Route to Sales",uncertainty:"Only visible controls are established."};
async function fixture(image=false) {
  const email=`release-${crypto.randomUUID()}@example.com`, user=await users.upsertByEmail(env.DB,email);
  const campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Explain the original pilot",grounding_refs:[],tone:"professional"});
  const bindings={...env,DEV_AUTH_EMAIL:email,PIPELINE:{...env.PIPELINE,send:vi.fn().mockResolvedValue(undefined)}};
  if(image){const form=new FormData();form.set("image_0",new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],"routing.png"));form.set("images_present","yes");form.set("image_role_0","inline");form.set("image_enhance_0","yes");await saveImageSelection(bindings,campaign.id,await validateImageSelection(form));}
  const run=await runs.create(env.DB,campaign.id,true);
  await runs.setState(env.DB,run.id,"ready");
  const article=await articles.create(env.DB,{run_id:run.id,title:"Original",body_html:"<p>Original prose.</p>",excerpt:"A pilot",meta_desc:"An original pilot",slug:"pilot",key_phrases:"[]",png_r2_key:null});
  return {bindings,campaign,run,article,images:runImages(run)};
}
function save(f:Awaited<ReturnType<typeof fixture>>,body:unknown){return worker.fetch(new Request(`https://x.test/articles/${f.article.id}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),f.bindings);}
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();vi.restoreAllMocks();}});

describe("release regressions: saved revisions and downloads",()=>{
  it("serves current prose before a queued cache rebuild and when the queue is unavailable",async()=>{
    const f=await fixture();await rebuildArticleBundle(f.bindings,f.article);
    f.bindings.PIPELINE.send.mockRejectedValue(new Error("Queue unavailable"));
    expect((await save(f,{version:0,body_html:"<p>New saved prose.</p>"})).status).toBe(200);
    expect((await articles.get(env.DB,f.article.id))?.bundle_r2_key).toBeNull();
    // Even a legacy pointer to stale bytes cannot bypass the fingerprint check.
    await articles.update(env.DB,f.article.id,{bundle_r2_key:`articles/${f.article.id}/bundle.zip`});
    const ctx=createExecutionContext();
    const response=await worker.fetch(new Request(`https://x.test/articles/${f.article.id}/bundle.zip`),f.bindings,ctx);
    expect(response.status).toBe(200);const files=unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(strFromU8(files["article.html"]!)).toContain("New saved prose");await waitOnExecutionContext(ctx);
  });
  it("rejects a stale browser revision and retains the newer saved text",async()=>{
    const f=await fixture();expect((await save(f,{version:0,body_html:"<p>First tab.</p>"})).status).toBe(200);
    const response=await save(f,{version:0,body_html:"<p>Stale second tab.</p>"});expect(response.status).toBe(409);expect(await response.text()).toContain("copy it");
    expect((await articles.get(env.DB,f.article.id))?.body_html).toContain("First tab");
    expect(await articles.updateIfCurrent(env.DB,f.article,{body_html:"<p>Late background composition.</p>"})).toBe(false);
  });
  it("prevents an older bundle builder replacing newer bytes after a concurrent save",async()=>{
    const f=await fixture();await rebuildArticleBundle(f.bindings,f.article);
    const put=f.bindings.ASSETS.put.bind(f.bindings.ASSETS);let raced=false;
    vi.spyOn(f.bindings.ASSETS,"put").mockImplementation(async(...args:Parameters<typeof put>)=>{
      if(args[0]===`articles/${f.article.id}/bundle.zip`&&!raced){raced=true;await articles.update(env.DB,f.article.id,{body_html:"<p>Newest revision.</p>"});await rebuildArticleBundle(f.bindings,(await articles.get(env.DB,f.article.id))!);}
      return put(...args);
    });
    await rebuildArticleBundle(f.bindings,f.article);
    const cached=await env.ASSETS.get(`articles/${f.article.id}/bundle.zip`);
    expect(strFromU8(unzipSync(new Uint8Array(await cached!.arrayBuffer()))["article.html"]!)).toContain("Newest revision");
  });
  it("rejects an image selection racing with a newer prose save",async()=>{
    const f=await fixture(true),image=f.images[0]!,key=enhancedImageKey(f.article.id,image);
    await env.ASSETS.put(key,"synthetic derivative");await env.ASSETS.put(uploadedPlacementKey(f.article.id),JSON.stringify({baseHash:"fixture",attempts:1,placements:[{imageId:image.id,afterParagraph:1,enhanced:"ready"}]}));
    const head=f.bindings.ASSETS.head.bind(f.bindings.ASSETS);let raced=false;
    vi.spyOn(f.bindings.ASSETS,"head").mockImplementation(async(...args:Parameters<typeof head>)=>{if(args[0]===key&&!raced){raced=true;await articles.update(env.DB,f.article.id,{body_html:"<p>Saved while selecting.</p>"});}return head(...args);});
    const response=await worker.fetch(new Request(`https://x.test/articles/${f.article.id}/uploaded-images/${image.id}/presentation`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({variant:"enhanced",version:0})}),f.bindings);
    expect(response.status).toBe(409);expect((await articles.get(env.DB,f.article.id))?.body_html).toContain("Saved while selecting");
  });
});

describe("release regressions: immutable run inputs",()=>{
  it("keeps earlier settings and source selections when the brief is edited",async()=>{
    const f=await fixture();await saveSourceUpload(f.bindings,f.campaign.id,new File(["Original supporting notes explain how to organise a small pilot deployment."],"original.txt"));
    const old=await runs.create(env.DB,f.campaign.id); // legacy run is frozen by the edit route
    const form=new FormData();form.set("idea","Explain a different production rollout");form.set("tone","friendly");form.set("upload",new File(["New notes explain a production deployment with a completely different scope."],"new.txt"));
    const response=await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`,{method:"POST",body:form}),f.bindings);expect(response.status).toBe(302);
    const snapshot=await campaignForRun(env.DB,(await runs.get(env.DB,old.id))!);expect(snapshot?.idea).toBe(f.campaign.idea);expect(snapshot?.tone).toBe("professional");
    for(let n=0;n<3;n++)await ingestSources(f.bindings,snapshot!,old.id);
    const report=await loadSourceReport(f.bindings,old.id);expect(report.map(r=>r.source)).toContain("original.txt");expect(report.map(r=>r.source)).not.toContain("new.txt");
    expect((await campaignForRun(env.DB,(await runs.get(env.DB,response.headers.get("location")!.split("/").pop()!))!))?.idea).toBe("Explain a different production rollout");
  });
  it("binds a submission to its own options even if another request updates the shared brief",async()=>{
    const f=await fixture(true),update=campaigns.update.bind(campaigns);
    vi.spyOn(campaigns,"update").mockImplementation(async(db,id,fields)=>{await update(db,id,fields);await update(db,id,{idea:"Concurrent other brief"});await saveSourceUpload(f.bindings,id,new File(["Unrelated later source details for a completely different article and request."],"later.txt"));await db.prepare("UPDATE campaign_images SET active=0 WHERE campaign_id=?").bind(id).run();});
    const form=new FormData();form.set("idea","My submitted pilot brief");form.set("upload",new File(["Relevant submitted source material for the requested small pilot deployment."],"mine.txt"));
    const response=await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`,{method:"POST",body:form}),f.bindings);expect(response.status).toBe(302);
    const run=(await runs.get(env.DB,response.headers.get("location")!.split("/").pop()!))!,campaign=(await campaignForRun(env.DB,run))!;
    expect(campaign.idea).toBe("My submitted pilot brief");expect(runImages(run)).toHaveLength(1);
    for(let n=0;n<3;n++)await ingestSources(f.bindings,campaign,run.id);
    const sources=(await loadSourceReport(f.bindings,run.id)).map(s=>s.source);expect(sources).toContain("mine.txt");expect(sources).not.toContain("later.txt");
  });
});

describe("release regressions: image reading recovery",()=>{
  it("waits for a shared reading instead of paying for it twice",async()=>{
    const f=await fixture(true),image=f.images[0]!;
    await env.DB.prepare("INSERT INTO image_read_leases(asset_key,owner,lease_until) VALUES (?,?,?)").bind(image.r2_key,"another-delivery",Date.now()+60000).run();
    await expect(readBuildImagesStep(f.bindings,f.images)).rejects.toBeInstanceOf(StageBusyError);
    await env.DB.prepare("UPDATE image_read_leases SET lease_until=0 WHERE asset_key=?").bind(image.r2_key).run();
    fetchMock.get("https://api.openai.com").intercept({path:"/v1/responses",method:"POST"}).reply(200,{status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(reading)}]}]});
    expect(await readBuildImagesStep(f.bindings,f.images)).toBe(false);expect(await readBuildImagesStep(f.bindings,f.images)).toBe(true);
    expect((await env.DB.prepare("SELECT owner FROM image_read_leases WHERE asset_key=?").bind(image.r2_key).first())).toBeNull();
  });
  it("does not spend a model attempt or mark an image unreadable after a storage outage",async()=>{
    const f=await fixture(true),image=f.images[0]!,get=f.bindings.ASSETS.get.bind(f.bindings.ASSETS);
    vi.spyOn(f.bindings.ASSETS,"get").mockImplementation(async(...args:Parameters<typeof get>)=>{if(args[0]===image.r2_key)throw new Error("Storage temporarily unavailable");return get(...args);});
    await expect(readBuildImagesStep(f.bindings,f.images)).rejects.toThrow("Storage temporarily unavailable");expect(await loadVisual(f.bindings,image)).toBeNull();
    expect(await env.DB.prepare("SELECT owner FROM image_read_leases WHERE asset_key=?").bind(image.r2_key).first()).toBeNull();
  });
  it("resets failed image-reading attempts on explicit retry and reuses successful readings",async()=>{
    const f=await fixture(true),image=f.images[0]!;
    await env.ASSETS.put(visualKey(image),JSON.stringify({version:1,state:"unavailable",attempts:3,error:"Retry limit"}));await resetFailedVisuals(f.bindings,f.images);
    expect(await loadVisual(f.bindings,image)).toMatchObject({state:"pending",attempts:0});
    await env.ASSETS.put(visualKey(image),JSON.stringify({version:1,state:"ready",attempts:1,reading}));await resetFailedVisuals(f.bindings,f.images);expect((await loadVisual(f.bindings,image))?.state).toBe("ready");
  });
  it("restarts actual failed source runs with an image-reading budget",async()=>{
    const f=await fixture(true),image=f.images[0]!;
    await env.ASSETS.put(visualKey(image),JSON.stringify({version:1,state:"unavailable",attempts:3}));await runs.setState(env.DB,f.run.id,"needs_input");
    await env.DB.prepare("INSERT INTO run_recovery(run_id,stage,due_at) VALUES (?,'assess',0)").bind(f.run.id).run();
    expect(await resumeSavedRun(f.bindings,f.run.id)).toBe(true);expect((await loadVisual(f.bindings,image))?.attempts).toBe(0);
    expect(f.bindings.PIPELINE.send).toHaveBeenCalledWith({runId:f.run.id,stage:"ingest"});
  });
  it("does not spend Auto decide failure budget while another run reads the same saved image",async()=>{
    const f=await fixture(true),image=f.images[0]!,id=`opt_${crypto.randomUUID().replaceAll("-","")}`;
    await env.DB.prepare("INSERT INTO brief_option_jobs(id,user_id,created_at) VALUES (?,?,?)").bind(id,f.campaign.user_id,Date.now()).run();
    await env.ASSETS.put(optionJobKey(id),JSON.stringify({fields:{},urls:[],images:f.images,text:"",read:0,uploadDone:true,warnings:[]}));
    await env.DB.prepare("INSERT INTO image_read_leases(asset_key,owner,lease_until) VALUES (?,?,?)").bind(image.r2_key,"other-run",Date.now()+60000).run();
    await stageAutoDecide(f.bindings,id);
    expect(await env.DB.prepare("SELECT state,failures FROM brief_option_jobs WHERE id=?").bind(id).first()).toEqual({state:"queued",failures:0});
    expect(f.bindings.PIPELINE.send).toHaveBeenCalledWith({runId:id,stage:"brief_options"},{delaySeconds:expect.any(Number)});
  });
});
