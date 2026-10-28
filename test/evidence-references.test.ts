import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { fetchMock } from "./network";
import { unzipSync, strFromU8 } from "fflate";
import { users,campaigns,runs,articles,topics } from "../src/db/repos";
import { ingestUpload, ingestUrl } from "../src/grounding/ingest";
import { sourceReportKey, groundingEvidenceForRun } from "../src/grounding/report";
import { creativeContextStep } from "../src/grounding/creative";
import { saveDiscoveredSources, discoveredSources, evidenceReferences, creativeContextKey, curateResearchReferences, researchCandidates } from "../src/grounding/research-references";
import { applyEvidenceLinks, referencesForChannel, citationFindings, ownerReferenceUrls, type EvidenceReference } from "../src/content/evidence-links";
import { prepareArticle } from "../src/content/finalize";
import { toMarkdown, toPlain } from "../src/content/render";
import { validateReview, type EditorialCheckpoint } from "../src/editorial/review";
import { stageWrite } from "../src/pipeline/run";
import { buildBundle } from "../src/bundle/export";
import { sourcePrompt } from "../src/grounding/evidence";

const url="https://en.wikipedia.org/wiki/Pilot_experiment",fact="A pilot study tests a process on a small scale before a wider rollout.";
const ref:EvidenceReference={sourceId:"S2",url,label:"Pilot study overview"};
const sources=[{id:"S1",label:"Owner notes",body:"The owner's service offers practical implementation support."},{id:"S2",label:"Pilot study",url,body:fact}];
const core={title:"A practical pilot",body_html:`<p>A pilot study tests a process on a <a href="${url}">small scale</a> before a wider rollout.</p>`,excerpt:fact,meta_desc:fact,slug:"practical-pilot",key_phrases:["pilot study"]};
const input={topicTitle:"A practical pilot",angle:"Practical",primaryKw:"pilot study",voiceProfileInstruction:"British English",maxWords:220,groundingText:fact,groundingSources:sources,evidenceReferences:[ref],outputFormat:"html" as const};
const options={referenceLinks:[],cta:null,signature:"",input};
function reply(value:unknown,predicate?:(body:string)=>boolean){fetchMock.get("https://api.anthropic.com").intercept({path:"/v1/messages",method:"POST",...(predicate?{body:predicate}:{})}).reply(200,{type:"message",role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(value)}]});}
async function fixture(){const user=await users.upsertByEmail(env.DB,`refs-${crypto.randomUUID()}@example.com`);const campaign=await campaigns.create(env.DB,{user_id:user.id,idea:"Explain a small pilot for our implementation service",grounding_refs:[],generation_version:2,max_words:220});const run=await runs.create(env.DB,campaign.id,true);return {campaign,run};}
beforeEach(()=>{fetchMock.activate();fetchMock.disableNetConnect();});
afterEach(()=>{try{fetchMock.assertNoPendingInterceptors();}finally{fetchMock.deactivate();vi.restoreAllMocks();}});

describe("public reference selection",()=>{
  it("keeps exact discovered public URLs, deduplicates and prefers neutral institutions",async()=>{
    const credentialled=new URL("https://host.example/doc");credentialled.username="fixture-user";credentialled.password="fixture-password";
    const items=researchCandidates([{url:"https://vendor.example/pricing",title:"Buy"},{url:"http://127.0.0.1/private",title:"Private"},{url:"https://news.example/guide",title:"Guide"},{url:url+"#history",title:"Pilot study"},{url,title:"Duplicate"},{url:credentialled.href,title:"Credentials"}]);
    expect(items.map(s=>s.url)).toEqual([url,"https://news.example/guide"]);
    const f=await fixture();await saveDiscoveredSources(env,f.run.id,items);expect(await discoveredSources(env,f.run.id)).toEqual(items);
    expect(sourcePrompt(sources)).toBe(sourcePrompt(sources.map(({url:_url,...source})=>source))); // legacy writing fingerprints stay stable
  });
  it("requires neutral, non-competing, relevant extracted pages and an exact quote",async()=>{
    const f=await fixture();reply({assessments:[{url,neutral:true,non_competing:false,relevant:true,label:"Pilot",source_quote:fact}]},body=>body.includes("competing vendors")&&body.includes("OWNER BRIEF"));
    expect(await curateResearchReferences(env,f.campaign,[{url,title:"Pilot"}],sources)).toEqual([]);
    reply({assessments:[{url,neutral:true,non_competing:true,relevant:true,label:"Pilot",source_quote:"An invented supporting quotation about pilots that is not present."}]});expect(await curateResearchReferences(env,f.campaign,[{url,title:"Pilot"}],sources)).toEqual([]);
    reply({assessments:[{url,neutral:true,non_competing:true,relevant:true,label:"Pilot",source_quote:fact}]});expect(await curateResearchReferences(env,f.campaign,[{url,title:"Pilot"}],sources)).toHaveLength(1);
    expect(await curateResearchReferences(env,f.campaign,[{url:"https://unread.example/",title:"Unread"}],sources)).toEqual([]);
  });
  it("reuses topic discoveries, reads before screening and never repeats completed calls",async()=>{
    const f=await fixture();const owner=await ingestUpload(env,f.campaign.id,"owner.txt",sources[0]!.body);await env.ASSETS.put(sourceReportKey(f.run.id),JSON.stringify([{source:"owner.txt",status:"loaded",docId:owner.doc.id}]));
    await saveDiscoveredSources(env,f.run.id,[{url,title:"Pilot study overview"}]);
    reply({needsSearch:false,query:"",scenarios:[]});await creativeContextStep(env,f.run.id,f.campaign,fact);
    fetchMock.get("https://en.wikipedia.org").intercept({path:"/wiki/Pilot_experiment"}).reply(200,fact,{headers:{"content-type":"text/plain"}});await creativeContextStep(env,f.run.id,f.campaign,fact);
    reply({assessments:[{url,neutral:true,non_competing:true,relevant:true,label:ref.label,source_quote:fact}]});await creativeContextStep(env,f.run.id,f.campaign,fact);
    expect(await creativeContextStep(env,f.run.id,f.campaign,fact)).not.toBeNull();const evidence=await groundingEvidenceForRun(env,f.campaign,f.run.id);
    expect(await evidenceReferences(env,f.run.id,evidence.sources)).toEqual([ref]);expect(await creativeContextStep(env,f.run.id,f.campaign,fact)).not.toBeNull();
  });
  it("keeps reference screening optional and bounded after an interruption",async()=>{
    const f=await fixture();await env.ASSETS.put(creativeContextKey(f.run.id),JSON.stringify({phase:"references",referenceVersion:1,referenceAttempted:true,query:"",notes:"Useful existing context",urls:[url],read:1,candidates:[{url,title:"Pilot"}]}));
    expect(await creativeContextStep(env,f.run.id,f.campaign,fact)).toBeNull();expect(await creativeContextStep(env,f.run.id,f.campaign,fact)).toBe("Useful existing context");expect(await evidenceReferences(env,f.run.id,sources)).toEqual([]);
    expect(await evidenceReferences(env,"legacy-run",sources)).toBeUndefined();
  });
});

describe("published citations and exports",()=>{
  it("links only used approved sources and lists them once after the prose",async()=>{
    const candidate=await prepareArticle({...core,body_html:core.body_html+'<p><a href="https://competitor.example/buy">Other vendor</a></p>'},options);
    expect(candidate.body_html).toContain(`<a href="${url}"`);expect(candidate.body_html).toContain("<h3>References</h3>");expect(candidate.body_html).not.toContain("https://competitor.example");expect(candidate.body_html.match(/Pilot study overview/g)).toHaveLength(1);
    const unused=await applyEvidenceLinks("<p>Practical advice with no public factual claim.</p>",[ref]);expect(unused.block).toBe("");
    expect(toMarkdown(candidate.body_html)).toContain(`[small scale](${url})`);expect(toPlain(candidate.body_html)).toContain(url);
  });
  it("keeps owner links and CTA while publishing no invented upload URL",async()=>{
    const candidate=await prepareArticle({...core,body_html:'<p><a href="https://invented.example/upload.pdf">Owner notes</a></p>'},{...options,referenceLinks:[{url:"https://owner.example/pricing",label:"Owner pricing"}]});
    expect(candidate.body_html).toContain("https://owner.example/pricing");expect(candidate.body_html).not.toContain("https://invented.example");expect(candidate.body_html).not.toContain("<h3>References</h3>");
    const ownerUrls=ownerReferenceUrls("Invite readers to https://owner.example/start. See (https://owner.example/guide).",[],null);
    expect(ownerUrls).toEqual(["https://owner.example/start","https://owner.example/guide"]);
    const requested=await prepareArticle({...core,body_html:'<p><a href="https://owner.example/start#signup">Start here</a></p>'},{...options,input:{...input,originalBrief:"Link to https://owner.example/start#signup"}});
    expect(requested.body_html).toContain('href="https://owner.example/start#signup"');expect(requested.body_html).not.toContain("<h3>References</h3>");
  });
  it("uses one compact reference without repeating its URL inline or inserting channel headings",async()=>{
    const candidate=await prepareArticle(core,{...options,input:{...input,outputFormat:"chat"}});
    expect(candidate.body_html).not.toMatch(/<h[1-6]/);expect(candidate.body_html.match(/href=/g)).toHaveLength(1);expect(toPlain(candidate.body_html).match(/https:/g)).toHaveLength(1);
    expect(referencesForChannel([{...ref,url:"https://reference.example/"+"x".repeat(400)}],"chat")).toEqual([]);
    const email=await prepareArticle(core,{...options,input:{...input,outputFormat:"email"}});expect(email.body_html.match(/href=/g)).toHaveLength(2);
  });
  it("requires the linked passage's exact source mapping and compares visible quotes without URL expansions",async()=>{
    const checkpoint:EditorialCheckpoint={version:1,state:"review",revision:0,model:"test",input:{...input,originalBrief:"Explain a pilot study"},core,finalMaxWords:220,referenceLinks:[],cta:null,signature:"",report:null};
    const candidate=await prepareArticle(core,checkpoint),report={checks:{factual_accuracy:true,brief_coverage:true,section_order:true,specificity:true,readability:true},requirements:[{brief_quote:"pilot study",article_quote:fact,covered:true}],facts:[{claim:fact,source_id:"S2",source_quote:fact}],issues:[]};
    expect(validateReview(report,candidate,checkpoint).passed).toBe(true);
    expect(citationFindings(core.body_html,[ref],sources,[{claim:fact,source_id:"S1",source_quote:sources[0]!.body}])).not.toEqual([]);
    expect(validateReview({...report,facts:[{claim:fact,source_id:"S1",source_quote:sources[0]!.body}]},candidate,checkpoint).passed).toBe(false);
  });
  it("passes the approved catalogue to the actual writing call and keeps references in the ZIP",async()=>{
    const f=await fixture(),owner=await ingestUpload(env,f.campaign.id,"owner.txt",sources[0]!.body);
    fetchMock.get("https://en.wikipedia.org").intercept({path:"/wiki/Pilot_experiment"}).reply(200,fact,{headers:{"content-type":"text/plain"}});const web=await ingestUrl(env,f.campaign.id,url);
    await env.ASSETS.put(sourceReportKey(f.run.id),JSON.stringify([{source:"owner.txt",status:"loaded",docId:owner.doc.id},{source:url,status:"loaded",docId:web.doc.id}]));
    await env.ASSETS.put(creativeContextKey(f.run.id),JSON.stringify({phase:"ready",referenceVersion:1,query:"",notes:"",urls:[url],read:1,references:[{url,label:ref.label,source_quote:fact}]}));
    const selected=await topics.createMany(env.DB,f.campaign.id,f.run.id,[{title:core.title,angle:"Practical",primary_kw:"pilot study"}]);await topics.select(env.DB,f.run.id,[selected[0]!.id]);await runs.setState(env.DB,f.run.id,"writing");
    reply(core,body=>body.includes("PUBLIC EVIDENCE LINKS")&&body.includes(url)&&body.includes("References block"));await stageWrite({...env,PIPELINE:{...env.PIPELINE,send:vi.fn().mockResolvedValue(undefined)}},f.run.id);
    const article=(await articles.listForRun(env.DB,f.run.id))[0]!;expect(article.body_html).toContain("<h3>References</h3>");
    const files=unzipSync(await buildBundle(env,article));expect(strFromU8(files["article.html"]!)).toContain(url);
  });
});
