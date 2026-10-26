import { creativeDirection } from "./image-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createMessageBatch } from "cloudflare:test";
import { fetchMock } from "./network";
import { base64ToBytes, generateImage } from "../src/openai/image";
import { featuredImagePrompt, planFeaturedImage, validateComposition } from "../src/images/brief";
import { RetryableError } from "../src/errors";
import { articles, campaigns, runs, users } from "../src/db/repos";
import { stageImage } from "../src/pipeline/run";
import { handleQueue } from "../src/pipeline/queue";
import { getRecovery } from "../src/pipeline/recovery";
import type { PipelineMessage } from "../src/env";

const sourceText = "Cloud PBX supports flexible working. Migration should start with a network assessment.";
const composition = { ...creativeDirection,
  headline: "A clearer path to cloud PBX", layout: "concept",
  points: [
    { label: "Flexible working", visual: "A desk connected to a cloud", sourceQuote: "Cloud PBX supports flexible working." },
    { label: "Assess your network", visual: "A simple network diagram", sourceQuote: "Migration should start with a network assessment." },
  ],
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";

describe("evidence-led image composition", () => {
  it("accepts distinct points supported by exact article quotes", () => {
    expect(validateComposition(composition, sourceText).points).toHaveLength(2);
  });
  it("rejects fabricated evidence and duplicate points", () => {
    expect(() => validateComposition({ ...composition, points: [composition.points[0], { ...composition.points[1], sourceQuote: "Our customers save fifty percent." }] }, sourceText)).toThrow(/unsupported/);
    expect(() => validateComposition({ ...composition, points: [composition.points[0], composition.points[0]] }, sourceText)).toThrow(/duplicate/);
  });
  it("rejects unsupported numeric labels, visuals and headlines", () => {
    expect(() => validateComposition({ ...composition, headline: "Save 50% now" }, sourceText)).toThrow();
    expect(() => validateComposition({ ...composition, points: [{ ...composition.points[0], label: "Save 50%" }, composition.points[1]] }, sourceText)).toThrow();
    expect(() => validateComposition({ ...composition, points: [{ ...composition.points[0], visual: "A chart showing 50% savings" }, composition.points[1]] }, sourceText)).toThrow();
  });
  it("rejects cluttered compositions and long labels", () => {
    expect(() => validateComposition({ ...composition, points: Array(5).fill(composition.points[0]) }, sourceText)).toThrow(/one to four/);
    expect(() => validateComposition({ ...composition, points: [{ ...composition.points[0], label: "A label with more than six whole words" }, composition.points[1]] }, sourceText)).toThrow();
  });
  it("builds concrete composition, typography and factual instructions", () => {
    const prompt = featuredImagePrompt(validateComposition(composition, sourceText), { title: "Cloud PBX", sourceText, userBrief: "brand blue, do not use photos" });
    expect(prompt).toContain("1536x1024");
    expect(prompt).toContain("Render ONLY these exact strings");
    expect(prompt).toContain("brand blue");
    expect(prompt).toContain("no invented numbers");
    expect(prompt).toContain("sourceQuote");
    expect(prompt).toContain("callouts are optional");
  });
  it("protects key content from wide preview crops on landscape and square canvases", () => {
    for (const outputFormat of ["html", "email", "linkedin", "chat"] as const) {
      const prompt = featuredImagePrompt(validateComposition(composition, sourceText), { title: "Pilot", sourceText, outputFormat });
      expect(prompt).toContain(outputFormat === "html" || outputFormat === "email" ? "top 20% and bottom 20%" : "top 30% and bottom 30%");
      expect(prompt).toContain("10% on the left and right");
      expect(prompt).toContain("ALL essential subject details");
      expect(prompt).toContain("not a literal white border");
      expect(prompt).not.toContain("8% safe margins");
    }
  });
  it("requires distinct creative alternatives and a valid selected direction", () => {
    expect(() => validateComposition({ ...composition, selectedConcept: 3 }, sourceText)).toThrow(/art direction/);
    expect(() => validateComposition({ ...composition, concepts: Array(3).fill(composition.concepts[0]) }, sourceText)).toThrow(/distinct concepts/);
    expect(() => validateComposition({ ...composition, artDirection: { ...composition.artDirection, scene: "" } }, sourceText)).toThrow(/art direction/);
  });
  it("allows one evidence anchor for a text-free editorial image without exposing alternative proposals", () => {
    const one = validateComposition({ ...composition, layout: "editorial", points: [composition.points[0]], artDirection: { ...composition.artDirection, textMode: "none" } }, sourceText);
    const prompt = featuredImagePrompt(one, { title: "Cloud PBX", sourceText });
    expect(prompt).toContain("No visible text, letters, numbers or captions");
    expect(prompt).toContain("A paper office unfolding");
    expect(prompt).not.toContain(composition.concepts[1]!.idea);
    expect(prompt).not.toContain("photographic backgrounds");
  });
});

async function makeImageRun() {
  const u = await users.upsertByEmail(env.DB, `image-${crypto.randomUUID()}@example.com`);
  const c = await campaigns.create(env.DB, { user_id: u.id, idea: "Cloud PBX", grounding_refs: [] });
  const r = await runs.create(env.DB, c.id);
  await runs.setState(env.DB, r.id, "asset_gen");
  const a = await articles.create(env.DB, { run_id: r.id, title: "Cloud PBX", body_html: `<p>${sourceText}</p>`, excerpt: "Cloud PBX explained.", slug: "cloud-pbx", meta_desc: "Cloud PBX explained.", key_phrases: '["cloud pbx"]', png_r2_key: null });
  return { runId: r.id, articleId: a.id };
}

function mockPlan() {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST", body: body => String(body).includes("OPEN GRAPH SAFE AREA") })
    .reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(composition) }] });
}

describe("image stage cost control and graceful failure", () => {
  beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
  afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });
  it("counts persistent image failures across fresh queue deliveries and releases the draft", async () => {
    const item = await makeImageRun();
    mockPlan();
    for (let i = 0; i < 3; i++) {
      fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(503, { error: { code: "server_error" } });
      await handleQueue(createMessageBatch<PipelineMessage>("test", [{ id: `new-${i}`, timestamp: new Date(), attempts: 1, body: { runId: item.runId, stage: "image" } }]), env);
    }
    expect((await getRecovery(env, item.runId))?.failures).toBe(2);
    expect((await runs.get(env.DB, item.runId))?.state).toBe("ready");
    expect((await articles.get(env.DB, item.articleId))?.body_html).toContain("network assessment");
  });

  it("reuses the saved evidence brief on a transient render retry and skips completed replays", async () => {
    const item = await makeImageRun();
    mockPlan();
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(429, { error: { code: "rate_limit_exceeded" } });
    await expect(stageImage(env, item.runId, 1)).rejects.toBeInstanceOf(RetryableError);
    expect((await runs.get(env.DB, item.runId))?.state).toBe("asset_gen");
    const cached = await env.ASSETS.get(`articles/${item.articleId}/image-brief.json`);
    expect(cached).not.toBeNull();
    const previous = await cached!.json<Record<string, unknown>>();
    expect(JSON.stringify(previous)).toContain("sourceQuote");
    previous.version = "2026-10-15.2";
    await env.ASSETS.put(`articles/${item.articleId}/image-brief.json`, JSON.stringify(previous));
    // No second planner intercept: a legacy retry must receive safe framing without replanning.
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST", body: body => String(body).includes("top 20% and bottom 20%") }).reply(200, { data: [{ b64_json: png }] });
    await stageImage(env, item.runId, 2);
    expect((await runs.get(env.DB, item.runId))?.state).toBe("ready");
    expect((await articles.get(env.DB, item.articleId))?.png_r2_key).toBe(`articles/${item.articleId}/featured.png`);
    await stageImage(env, item.runId, 3);
  });

  it("preserves the article and download bundle after final image failure", async () => {
    const item = await makeImageRun();
    mockPlan();
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(503, { error: { code: "server_error" } });
    await stageImage(env, item.runId, 3);
    const result = await articles.get(env.DB, item.articleId);
    expect((await runs.get(env.DB, item.runId))?.state).toBe("ready");
    expect(result?.body_html).toContain("network assessment");
    expect(result?.png_r2_key).toBeNull();
    expect(result?.bundle_r2_key).toBeTruthy();
  });

  it("recovers an already-written PNG without buying or planning another image", async () => {
    const item = await makeImageRun();
    const key = `articles/${item.articleId}/featured.png`;
    await env.ASSETS.put(key, base64ToBytes(png), { httpMetadata: { contentType: "image/png" } });
    await stageImage(env, item.runId);
    expect((await articles.get(env.DB, item.articleId))?.png_r2_key).toBe(key);
    expect((await runs.get(env.DB, item.runId))?.state).toBe("ready");
  });

  it("does not pay for planning when the image secret is missing", async () => {
    const item = await makeImageRun();
    await stageImage({ ...env, OPENAI_API_KEY: undefined }, item.runId);
    expect((await runs.get(env.DB, item.runId))?.state).toBe("ready");
    expect(await env.ASSETS.get(`articles/${item.articleId}/image-brief.json`)).toBeNull();
  });
});

describe("OpenAI image integration", () => {
  beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
  afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });
  it("decodes base64 into exact bytes", () => {
    expect(Array.from(base64ToBytes("UE5H"))).toEqual([80, 78, 71]);
  });
  it("plans from the full article using Claude Opus 5.5 before rendering", async () => {
    fetchMock.get("https://api.anthropic.com").intercept({
      path: "/v1/messages", method: "POST",
      body: (body) => String(body).includes("network assessment") && String(body).includes("sourceQuote")
        && String(body).includes("Premium photographic") && String(body).includes("Previous paper room"),
    }).reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(composition) }] });
    const result = await planFeaturedImage(env, { title: "Cloud PBX", sourceText, styleDirection: "Premium photographic", previousConcept: "Previous paper room" });
    expect(result.composition.points).toHaveLength(2);
    expect(result.prompt).toContain("Assess your network");
  });
  it("uses Sunburst, one medium-quality landscape PNG, moderation, and the OpenAI secret", async () => {
    fetchMock.get("https://api.openai.com").intercept({
      path: "/v1/images/generations", method: "POST",
      headers: { authorization: "Bearer test-openai-key" },
      body: (body) => {
        const value = JSON.parse(String(body));
        return value.model === "gpt-image-2.5-sunburst" && value.quality === "medium"
          && value.size === "1536x1024" && value.n === 1 && value.moderation === "auto" && value.output_format === "png";
      },
    }).reply(200, { data: [{ b64_json: png }] });
    const image = await generateImage(env, "Evidence-backed infographic");
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes[0]).toBe(0x89);
  });
  it("retries rate limits without exposing provider messages", async () => {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" })
      .reply(429, { error: { code: "rate_limit_exceeded", message: "private prompt text" } });
    await expect(generateImage(env, "x")).rejects.toThrow(RetryableError);
  });
  it("does not retry quota or moderation failures", async () => {
    for (const [status, code] of [[429, "insufficient_quota"], [400, "moderation_blocked"]] as const) {
      fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(status, { error: { code } });
      const error = await generateImage(env, "x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RetryableError);
    }
  });
  it("rejects non-image payloads and missing configuration", async () => {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" }).reply(200, { data: [{ b64_json: "UE5H" }] });
    await expect(generateImage(env, "x")).rejects.toThrow(/invalid PNG/);
    await expect(generateImage({ ...env, OPENAI_API_KEY: undefined }, "x")).rejects.toThrow(/not configured/);
  });
});
