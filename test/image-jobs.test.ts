import { creativeDirection } from "./image-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { articles, campaigns, runs, users } from "../src/db/repos";
import { imageJobs } from "../src/db/image-jobs";
import { articleImageBriefKey, imageJobPrefix } from "../src/images/assets";
import { imageFailureMessage } from "../src/images/errors";
import { renderFeaturedVisual } from "../src/images/render";
import { ImageJobBusyError, stageImageJob } from "../src/pipeline/image-job";
import { RetryableError } from "../src/errors";
import { unzipSync, strFromU8 } from "fflate";

const text = "Cloud PBX supports flexible working. Migration should start with a network assessment.";
const composition = { ...creativeDirection, headline: "A clearer path to cloud PBX", layout: "concept", points: [
  { label: "Flexible working", visual: "A desk connected to a cloud", sourceQuote: "Cloud PBX supports flexible working." },
  { label: "Assess your network", visual: "A simple network diagram", sourceQuote: "Migration should start with a network assessment." },
] };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";

async function fixture(email = "dev@example.com", state: "ready" | "writing" = "ready") {
  const user = await users.upsertByEmail(env.DB, email);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Cloud PBX", grounding_refs: [] });
  const run = await runs.create(env.DB, campaign.id);
  await runs.setState(env.DB, run.id, state);
  const article = await articles.create(env.DB, { run_id: run.id, title: "Cloud PBX", body_html: `<p>${text}</p>`, excerpt: "e", slug: "cloud-pbx", meta_desc: "m", key_phrases: "[]", png_r2_key: null });
  return { article, campaign, run };
}
function plan(previousScene?: string) {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST",
    ...(previousScene ? { body: (body: unknown) => String(body).includes(previousScene) && String(body).includes("previousConcept") } : {}),
  })
    .reply(200, { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(composition) }] });
}
function render(status = 200, code = "server_error") {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/images/generations", method: "POST" })
    .reply(status, status === 200 ? { data: [{ b64_json: png }] } : { error: { code, message: "PRIVATE PROVIDER TEXT" } });
}
function request(articleId: string, mode: unknown, origin?: string) {
  return SELF.fetch(`https://x.test/articles/${articleId}/image`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ mode }) });
}

describe("image-only routes and cost guardrails", () => {
  it("queues Retry without changing the article or rewinding its ready run", async () => {
    const { article, run } = await fixture();
    expect((await request(article.id, "retry")).status).toBe(202);
    expect((await runs.get(env.DB, run.id))?.state).toBe("ready");
    expect((await articles.get(env.DB, article.id))?.body_html).toBe(article.body_html);
    expect((await imageJobs.get(env.DB, article.id))?.mode).toBe("retry");
    const status = await SELF.fetch(`https://x.test/articles/${article.id}/image-status`);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect((await status.json() as { state: string }).state).toBe("queued");
  });
  it("allows just one concurrent image request and one exclusive consumer", async () => {
    const { article } = await fixture();
    const results = await Promise.all([request(article.id, "retry"), request(article.id, "new")]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    const job = (await imageJobs.get(env.DB, article.id))!;
    const claims = await Promise.all([imageJobs.claim(env.DB, article.id, job.id), imageJobs.claim(env.DB, article.id, job.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await imageJobs.get(env.DB, article.id))?.request_count).toBe(1);
  });
  it("isolates tenants and rejects cross-origin requests, invalid modes and unfinished runs", async () => {
    const other = await fixture(`other-${crypto.randomUUID()}@example.com`);
    expect((await request(other.article.id, "new")).status).toBe(404);
    expect((await SELF.fetch(`https://x.test/articles/${other.article.id}/image-status`)).status).toBe(404);
    const own = await fixture();
    expect((await request(own.article.id, "new", "https://evil.test")).status).toBe(403);
    expect((await request(own.article.id, "bogus")).status).toBe(400);
    const active = await fixture("dev@example.com", "writing");
    expect((await request(active.article.id, "retry")).status).toBe(409);
  });
  it("caps manual requests at five per hour and resets the window", async () => {
    const { article } = await fixture();
    for (let i = 0; i < 5; i++) {
      const job = await imageJobs.request(env.DB, article.id, "new", null);
      expect(job).not.toBeNull();
      await imageJobs.finish(env.DB, article.id, job!.id, "failed");
    }
    expect((await request(article.id, "new")).status).toBe(429);
    await env.DB.prepare("UPDATE article_image_jobs SET window_started_at = ? WHERE article_id = ?").bind(Date.now() - 3_600_001, article.id).run();
    expect((await request(article.id, "new")).status).toBe(202);
    expect((await imageJobs.get(env.DB, article.id))?.request_count).toBe(1);
  });
  it("does not rerender an already-good visual via Retry", async () => {
    const { article } = await fixture();
    await articles.update(env.DB, article.id, { png_r2_key: `articles/${article.id}/featured.png` });
    expect((await request(article.id, "retry")).status).toBe(409);
    expect((await request(article.id, "new")).status).toBe(202);
  });
  it("renders both buttons and disables them while a job is pending", async () => {
    const { article, run } = await fixture();
    let page = await (await SELF.fetch(`https://x.test/runs/${run.id}`)).text();
    expect(page).toContain('data-image-mode="retry"');
    expect(page).toContain('data-image-mode="new"');
    await request(article.id, "retry");
    page = await (await SELF.fetch(`https://x.test/runs/${run.id}`)).text();
    expect(page).toContain('data-image-mode="retry" disabled');
    expect(page).toContain('data-image-mode="new" disabled');
    expect(page).toContain('data-image-pending="true"');
  });
  it("keeps the visual accordion expanded and exposes a direct PNG download when available", async () => {
    const { article, run } = await fixture();
    let page = await (await SELF.fetch(`https://x.test/runs/${run.id}`)).text();
    expect(page).toContain('<details class="fold" open><summary>Featured visual');
    expect(page).toContain('disabled title="Available once a visual has been generated">Download Image');
    await articles.update(env.DB, article.id, { png_r2_key: `articles/${article.id}/featured.png` });
    page = await (await SELF.fetch(`https://x.test/runs/${run.id}`)).text();
    expect(page).toContain('<details class="fold" open><summary>Featured visual');
    expect(page).toContain(`href="/articles/${article.id}/images/original/featured.png" download title="Download the full-resolution featured visual as a PNG">Download Image</a>`);
  });
  it("makes queue-send failures retryable from the UI instead of leaving a stuck pending job", async () => {
    const { article } = await fixture();
    const send = vi.spyOn(env.PIPELINE, "send").mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      expect((await request(article.id, "retry")).status).toBe(503);
      expect((await imageJobs.get(env.DB, article.id))?.state).toBe("failed");
    } finally { send.mockRestore(); }
  });
});

describe("image-only generation and recovery", () => {
  beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
  afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });
  it("reuses a saved brief on Retry and pairs the new image and brief in downloads", async () => {
    const { article, run, campaign } = await fixture();
    plan(); render(401, "invalid_api_key");
    await expect(renderFeaturedVisual(env, article, campaign, { pngKey: `articles/${article.id}/featured.png`, briefKey: articleImageBriefKey(article) })).rejects.toThrow(/401/);
    expect((await request(article.id, "retry")).status).toBe(202);
    const job = (await imageJobs.get(env.DB, article.id))!;
    // No second OpenAI text interceptor: using Retry must not buy another plan.
    render();
    await stageImageJob(env, run.id, article.id, job.id);
    const updated = (await articles.get(env.DB, article.id))!;
    expect(updated.body_html).toBe(article.body_html);
    expect(updated.png_r2_key).toBe(`${imageJobPrefix(article.id, job.id)}/featured.png`);
    expect((await imageJobs.get(env.DB, article.id))?.state).toBe("ready");
    expect((await runs.get(env.DB, run.id))?.state).toBe("ready");
    const brief = await SELF.fetch(`https://x.test/articles/${article.id}/image-brief`);
    expect((await brief.json() as { composition: unknown }).composition).toEqual(composition);
    const bundle = await env.ASSETS.get(updated.bundle_r2_key!);
    const files = unzipSync(new Uint8Array(await bundle!.arrayBuffer()));
    expect(files["featured.png"]).toBeDefined();
    expect(strFromU8(files["image-brief.json"]!)).toContain("Assess your network");
    await stageImageJob(env, run.id, article.id, job.id); // completed replay buys nothing
  });
  it("plans a fresh brief for Generate New but reuses it on a transient render retry", async () => {
    const { article, run, campaign } = await fixture();
    plan(); render();
    const oldKey = await renderFeaturedVisual(env, article, campaign, { pngKey: `articles/${article.id}/featured.png`, briefKey: articleImageBriefKey(article) });
    await articles.update(env.DB, article.id, { png_r2_key: oldKey });
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    plan(composition.artDirection.scene); render(503);
    await expect(stageImageJob(env, run.id, article.id, job.id, 1)).rejects.toBeInstanceOf(RetryableError);
    expect((await articles.get(env.DB, article.id))?.png_r2_key).toBe(oldKey);
    render();
    await stageImageJob(env, run.id, article.id, job.id, 2);
    expect((await articles.get(env.DB, article.id))?.png_r2_key).not.toBe(oldKey);
    // Original bytes and their matching brief remain accessible after regeneration.
    const original = await SELF.fetch(`https://x.test/articles/${article.id}/images/original/featured.png`);
    expect(original.status).toBe(200);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(Uint8Array.from(atob(png), (c) => c.charCodeAt(0)));
    const history = await SELF.fetch(`https://x.test/articles/${article.id}/images`);
    const gallery = await history.json() as { version: string; count: number; html: string };
    expect(gallery.version).toBe(job.id);
    expect(gallery.count).toBe(2);
    expect(gallery.html).toContain("Saved images (1)");
    expect(gallery.html).toContain(`/images/${job.id}/featured.png`);
    expect(gallery.html).toContain("/images/original/featured.png");
  });
  it("preserves an existing image and exposes only a safe actionable authentication error", async () => {
    const { article, run } = await fixture();
    await articles.update(env.DB, article.id, { png_r2_key: "previous-good-image" });
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    plan(); render(401, "invalid_api_key");
    await stageImageJob(env, run.id, article.id, job.id);
    expect((await articles.get(env.DB, article.id))?.png_r2_key).toBe("previous-good-image");
    const status = await SELF.fetch(`https://x.test/articles/${article.id}/image-status`);
    const payload = await status.text();
    expect(payload).toContain("OPENAI_API_KEY");
    expect(payload).not.toContain("PRIVATE PROVIDER TEXT");
    expect((await runs.get(env.DB, run.id))?.state).toBe("ready");
    expect((await request(article.id, "retry")).status).toBe(202);
  });
  it("ignores stale deliveries and delays when another consumer owns the job", async () => {
    const { article, run } = await fixture();
    const first = (await imageJobs.request(env.DB, article.id, "new", null))!;
    await imageJobs.finish(env.DB, article.id, first.id, "failed");
    const latest = (await imageJobs.request(env.DB, article.id, "new", null))!;
    await stageImageJob(env, run.id, article.id, first.id);
    const owner = await imageJobs.claim(env.DB, article.id, latest.id);
    expect(owner).toBeTruthy();
    await expect(stageImageJob(env, run.id, article.id, latest.id)).rejects.toBeInstanceOf(ImageJobBusyError);
    expect((await imageJobs.get(env.DB, article.id))?.state).toBe("working");
    await imageJobs.release(env.DB, article.id, latest.id, owner!);
  });
  it("recovers a rendered job after a crash without buying a second image", async () => {
    const { article, run, campaign } = await fixture();
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    const prefix = imageJobPrefix(article.id, job.id);
    plan(); render();
    await renderFeaturedVisual(env, article, campaign, { pngKey: `${prefix}/featured.png`, briefKey: `${prefix}/image-brief.json` });
    await stageImageJob(env, run.id, article.id, job.id);
    expect((await imageJobs.get(env.DB, article.id))?.state).toBe("ready");
  });
  it("does not attach a recovered visual to an article edited after rendering", async () => {
    const { article, run, campaign } = await fixture();
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    const prefix = imageJobPrefix(article.id, job.id);
    plan(); render();
    await renderFeaturedVisual(env, article, campaign, { pngKey: `${prefix}/featured.png`, briefKey: `${prefix}/image-brief.json` });
    await articles.update(env.DB, article.id, { body_html: "<p>A newly saved article.</p>" });
    await stageImageJob(env, run.id, article.id, job.id);
    expect((await articles.get(env.DB, article.id))?.png_r2_key).toBeNull();
    expect((await imageJobs.get(env.DB, article.id))?.error).toContain("article changed");
  });
  it("marks exhausted transient failures as failed without damaging the article", async () => {
    const { article, run } = await fixture();
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    plan(); render(503);
    await stageImageJob(env, run.id, article.id, job.id, 3);
    expect((await imageJobs.get(env.DB, article.id))?.state).toBe("failed");
    expect((await articles.get(env.DB, article.id))?.body_html).toBe(article.body_html);
    expect((await runs.get(env.DB, run.id))?.state).toBe("ready");
  });
  it("removes job state and private historical assets when the owner deletes the campaign", async () => {
    const { article, campaign } = await fixture();
    const job = (await imageJobs.request(env.DB, article.id, "new", null))!;
    const prefix = imageJobPrefix(article.id, job.id);
    await env.ASSETS.put(`${prefix}/image-brief.json`, "private failed brief");
    await env.ASSETS.put(`${prefix}/featured.png`, "private previous image");
    await env.ASSETS.put(`articles/${article.id}/featured.png`, "private original image");
    const response = await SELF.fetch(`https://x.test/campaigns/${campaign.id}/delete`, { method: "POST", redirect: "manual" });
    expect(response.status).toBe(302);
    expect(await imageJobs.get(env.DB, article.id)).toBeNull();
    expect(await env.ASSETS.get(`${prefix}/image-brief.json`)).toBeNull();
    expect(await env.ASSETS.get(`${prefix}/featured.png`)).toBeNull();
    expect(await env.ASSETS.get(`articles/${article.id}/featured.png`)).toBeNull();
  });
});

describe("safe image failure guidance", () => {
  it("distinguishes authentication, project access, billing, planning and moderation", () => {
    expect(imageFailureMessage(new Error("OpenAI image generation failed (401, invalid_api_key)"))).toContain("authentication");
    expect(imageFailureMessage(new Error("OpenAI image generation failed (403, provider_error)"))).toContain("model access");
    expect(imageFailureMessage(new Error("OpenAI image generation failed (429, insufficient_quota)"))).toContain("billing");
    expect(imageFailureMessage(new Error("Image planning did not produce an evidence-backed composition"))).toContain("brief");
    expect(imageFailureMessage(new Error("The image brief could not be processed."))).toContain("Review the article");
    expect(imageFailureMessage(new Error("PRIVATE SOURCE OR PROVIDER TEXT"))).not.toContain("PRIVATE");
  });
});
