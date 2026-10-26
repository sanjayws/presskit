import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import worker from "../src/index";
import { users, campaigns, runs, articles, topics } from "../src/db/repos";
import { campaignImages, inspectImage, validateImageSelection, saveImageSelection, runImages, uploadedImageUrl, uploadedImageFile, exportUploadedHtml, uploadedChannelError } from "../src/images/uploads";
import { uploadedImageStep } from "../src/images/uploaded-inline";
import { inlineImageStep } from "../src/images/inline";
import { stageImage } from "../src/pipeline/run";
import { buildBundle } from "../src/bundle/export";
import { listImageVersions } from "../src/images/history";
import { sanitizeHtml } from "../src/content/sanitize";
import { changeHistory, cleanDeletedAssets } from "../src/db/history";
import { optionJobKey } from "../src/editorial/auto-decide";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=";
const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjaKKK988E/9k=";
const webp = "UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ql//G7cYb8F3/kFpXLd2AAAAA==";
const bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
function formWithImage(role = "inline", data = png, name = "routing.png") {
  const form = new FormData();
  form.set("idea", "A fictional story about setting up call routing"); form.set("article_type", "fiction");
  form.set("images_present", "yes"); form.set("image_0", new File([bytes(data)], name));
  form.set("image_role_0", role); form.set("image_description_0", 'Call routing settings with a "pilot" group');
  return form;
}
async function fixture(form = formWithImage()) {
  const email = `upload-${crypto.randomUUID()}@example.com`;
  const user = await users.upsertByEmail(env.DB, email);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Call routing", grounding_refs: [], article_type: "fiction" });
  const bindings = { ...env, DEV_AUTH_EMAIL: email, PIPELINE: { ...env.PIPELINE, send: vi.fn().mockResolvedValue(undefined) } };
  await saveImageSelection(bindings, campaign.id, await validateImageSelection(form));
  const run = await runs.create(env.DB, campaign.id);
  const article = await articles.create(env.DB, { run_id: run.id, title: "A useful pilot", body_html: "<p>Plan the pilot.</p><h2>Set up call routing</h2><p>Configure call routing settings for the pilot group.</p>", excerpt: "A practical setup story.", slug: "pilot", meta_desc: "Follow the setup story.", key_phrases: "[]", png_r2_key: null });
  return { user, campaign, run, article, bindings, images: runImages(run) };
}
function reply(placements: unknown) {
  fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(200, { type: "message", role: "assistant", content: [{ type: "text", text: JSON.stringify({ placements: (placements as {imageId:string;afterParagraph:number}[]).map((p)=>({...p,enhance:false,enhancementPrompt:""})) }) }], stop_reason: "end_turn" });
}
beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => { try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); } });

describe("own image validation and saved selections", () => {
  it("recognises real PNG, JPEG and WebP bytes and dimensions instead of trusting MIME", () => {
    expect(inspectImage(bytes(png))).toEqual({ content_type: "image/png", width: 1, height: 1 });
    expect(inspectImage(bytes(jpeg))).toEqual({ content_type: "image/jpeg", width: 2, height: 3 });
    expect(inspectImage(bytes(webp))).toEqual({ content_type: "image/webp", width: 2, height: 3 });
    for (const content of ["<svg onload='alert(1)'></svg>", "<html>Not an image</html>", "GIF89a"]) expect(() => inspectImage(new TextEncoder().encode(content))).toThrow("Use a PNG");
    expect(() => inspectImage(bytes(png).subarray(0, 35))).toThrow();
    const oversized = bytes(png); new DataView(oversized.buffer).setUint32(16, 9000);
    expect(() => inspectImage(oversized)).toThrow("8,192");
    const huge = bytes(png); const view = new DataView(huge.buffer); view.setUint32(16, 6000); view.setUint32(20, 6000);
    expect(() => inspectImage(huge)).toThrow("24 megapixels");
  });
  it("enforces all upload limits, roles and extensions before storage or models", async () => {
    const mismatch = formWithImage("inline", png, "photo.jpg"); await expect(validateImageSelection(mismatch)).rejects.toThrow("do not match");
    const large = formWithImage(); large.set("image_0", new File([new Uint8Array(3000001)], "large.png"));
    await expect(validateImageSelection(large)).rejects.toThrow("3 MB");
    const extra = formWithImage(); extra.set("image_6", new File([bytes(png)], "extra.png"));
    await expect(validateImageSelection(extra)).rejects.toThrow("at most 6");
    const duplicate = formWithImage(); duplicate.append("image_0", new File([bytes(png)], "duplicate.png"));
    await expect(validateImageSelection(duplicate)).rejects.toThrow("at most 6");
    const badRole = formWithImage("external"); await expect(validateImageSelection(badRole)).rejects.toThrow("Choose Hero");
    const badDescription = formWithImage(); badDescription.set("image_description_0", "x".repeat(241));
    await expect(validateImageSelection(badDescription)).rejects.toThrow("1–240");
    const heroes = formWithImage("hero"); heroes.set("image_1", new File([bytes(png)], "other.png")); heroes.set("image_role_1", "hero");
    await expect(validateImageSelection(heroes)).rejects.toThrow("only one");
    const f = await fixture(); const selected = f.images[0]!;
    const keep = new FormData(); keep.set("images_present", "yes");
    for (let n = 0; n < 4; n++) {
      const id = `upl_${String(n).padStart(32, "0")}`; keep.append("keep_image", id); keep.set(`image_role_${id}`, "inline"); keep.set(`image_description_${id}`, "Settings");
    }
    await expect(validateImageSelection(keep, Array.from({ length: 4 }, (_, n) => ({ ...selected, id: `upl_${String(n).padStart(32, "0")}`, bytes: 3000000 })))).rejects.toThrow("10 MB combined");
  });
  it("rejects invalid uploads on submission and Auto decide before queueing or saving", async () => {
    const f = await fixture(); const invalid = formWithImage(); invalid.set("image_0", new File(["<svg onload='alert(1)'>"], "bad.png", { type: "image/png" }));
    for (const path of ["/campaigns", `/campaigns/${f.campaign.id}`, "/brief/auto-decide"]) {
      const response = await worker.fetch(new Request(`https://x.test${path}`, { method: "POST", body: invalid }), f.bindings);
      expect(response.status).toBe(400); expect(await response.text()).toContain("PNG");
    }
    expect(f.bindings.PIPELINE.send).not.toHaveBeenCalled();
    expect(await campaignImages(env.DB, f.campaign.id)).toHaveLength(1);
  });
  it("keeps uploads visible on edit, saves description changes per run and preserves old copies", async () => {
    const f = await fixture(); const image = f.images[0]!;
    const page = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/edit`), f.bindings);
    const html = await page.text(); expect(html).toContain(image.filename); expect(html).toContain('name="keep_image"'); expect(html).toContain("Keep routing.png");
    const edit = new FormData(); edit.set("idea", "An updated fictional pilot story"); edit.set("article_type", "fiction"); edit.set("images_present", "yes");
    edit.append("keep_image", image.id); edit.set(`image_role_${image.id}`, "hero"); edit.set(`image_description_${image.id}`, "Updated image description");
    const response = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}`, { method: "POST", body: edit }), f.bindings);
    expect(response.status).toBe(302);
    const next = (await runs.get(env.DB, response.headers.get("location")!.split("/").pop()!))!;
    expect(runImages(next)[0]?.role).toBe("hero"); expect(runImages(next)[0]?.description).toBe("Updated image description");
    expect(runImages((await runs.get(env.DB, f.run.id))!)[0]?.description).toBe(image.description);
    await saveImageSelection(f.bindings, f.campaign.id, { saved: [], added: [] });
    expect(await campaignImages(env.DB, f.campaign.id)).toHaveLength(0);
    expect((await worker.fetch(new Request(`https://x.test${uploadedImageUrl(f.article.id, image.id)}`), f.bindings)).status).toBe(200);
    expect((await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/images/${image.id}`), f.bindings)).status).toBe(404);
  });
  it("scopes saved-image selections, downloads and edits to their owner and run", async () => {
    const a = await fixture(); const b = await fixture(); const image = a.images[0]!;
    const forged = new FormData(); forged.set("images_present", "yes"); forged.append("keep_image", b.images[0]!.id);
    await expect(validateImageSelection(forged, a.images)).rejects.toThrow("unavailable");
    for (const path of [`/campaigns/${a.campaign.id}/images/${image.id}`, uploadedImageUrl(a.article.id, image.id)]) expect((await worker.fetch(new Request(`https://x.test${path}`), b.bindings)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://x.test${uploadedImageUrl(a.article.id, b.images[0]!.id)}`), a.bindings)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://x.test/campaigns/${a.campaign.id}`, { method: "POST", headers: { origin: "https://evil.test" }, body: formWithImage() }), a.bindings)).status).toBe(403);
    const own = `<figure data-presskit-upload="${image.id}"><img src="${uploadedImageUrl(a.article.id,image.id)}" onerror="alert(1)"></figure>`;
    expect(await sanitizeHtml(own, a.article.id)).not.toContain("<img");
    expect(await sanitizeHtml(own, a.article.id, [image.id])).toContain("<img");
    expect(await sanitizeHtml(own, a.article.id, [image.id])).not.toContain("onerror");
    expect(await sanitizeHtml(own.replace(image.id, b.images[0]!.id), a.article.id, [image.id])).not.toContain("data-presskit-upload");
  });
  it("Auto decide saves selected originals privately for background visual reading", async () => {
    const f = await fixture(); const form = formWithImage("hero", webp, "pilot.webp");
    const response = await worker.fetch(new Request("https://x.test/brief/auto-decide", { method: "POST", body: form }), f.bindings);
    expect(response.status).toBe(202); const { id } = await response.json<{ id: string }>();
    const request = await (await env.ASSETS.get(optionJobKey(id)))!.json<{ fields: Record<string,string>; fileKey?: string }>();
    expect(JSON.parse(request.fields.uploaded_image_descriptions!)).toEqual([expect.objectContaining({ description: 'Call routing settings with a "pilot" group', role: "hero" })]);
    expect(request.fileKey).toBeUndefined();
    expect(await campaignImages(env.DB, f.campaign.id)).toHaveLength(1);
  });
  it("checks email/Word image compatibility before starting paid work", async () => {
    const form = formWithImage("hero", webp, "pilot.webp"); form.set("output_format", "email");
    const f = await fixture(formWithImage("hero", webp, "pilot.webp"));
    expect(uploadedChannelError(f.images, ["html","email"])).toContain("PNG or JPEG");
    expect(uploadedChannelError(f.images.map((image) => ({ ...image, role: "attachment" })), ["email"])).toBeNull();
    for (const path of ["/campaigns", `/campaigns/${f.campaign.id}`, "/brief/auto-decide"]) {
      const response = await worker.fetch(new Request(`https://x.test${path}`, { method: "POST", body: form }), f.bindings);
      expect(response.status).toBe(400); expect(await response.text()).toContain("Email and Word");
    }
    await runs.setState(env.DB, f.run.id, "awaiting_topic_selection");
    const angles = await topics.createMany(env.DB, f.campaign.id, f.run.id, [{ title: "Pilot", angle: "Setup", primary_kw: "pilot" }]);
    const select = new FormData(); select.set("topic", angles[0]!.id); select.set("output_format", "email");
    expect((await worker.fetch(new Request(`https://x.test/runs/${f.run.id}/select`, { method: "POST", body: select }), f.bindings)).status).toBe(400);
    expect(f.bindings.PIPELINE.send).not.toHaveBeenCalled();
  });
});

describe("uploaded image build, export and recovery", () => {
  it("uses an uploaded JPEG hero with no image API call, keeps history and correct download extensions", async () => {
    const f = await fixture(formWithImage("hero", jpeg, "my-photo.jpg"));
    await runs.setState(env.DB, f.run.id, "asset_gen");
    await stageImage(f.bindings, f.run.id);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("ready");
    const article = (await articles.get(env.DB, f.article.id))!;
    const versions = await listImageVersions(env.ASSETS, article);
    expect(versions).toHaveLength(1); expect(versions[0]?.uploaded).toBe(true);
    const response = await worker.fetch(new Request(`https://x.test/articles/${article.id}/images/original/featured.png`), f.bindings);
    expect(response.headers.get("content-type")).toBe("image/jpeg"); expect(response.headers.get("content-disposition")).toContain(".jpg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes(jpeg));
    const files = unzipSync(await buildBundle(f.bindings, article)); expect(files["featured.jpg"]).toEqual(bytes(jpeg)); expect(files["featured.png"]).toBeUndefined();
    expect(files[uploadedImageFile(f.images[0]!)]).toEqual(bytes(jpeg));
    const page = await worker.fetch(new Request(`https://x.test/runs/${f.run.id}`), f.bindings); expect(await page.text()).toContain("Your uploaded image");
    await stageImage(f.bindings, f.run.id); // ready replay makes no paid requests
  });
  it("plans placement once, preserves original pixels, sanitises edits and exports portable HTML and ZIP assets", async () => {
    const f = await fixture(); const image = f.images[0]!;
    reply([{ imageId: image.id, afterParagraph: 2 }]);
    expect(await uploadedImageStep(f.bindings, f.article, f.run)).toBe(false);
    expect(await uploadedImageStep(f.bindings, f.article, f.run)).toBe(true);
    let article = (await articles.get(env.DB, f.article.id))!;
    expect(article.body_html).toContain(`data-presskit-upload="${image.id}"`); expect(article.body_html).toContain("&quot;pilot&quot;");
    expect(article.body_html).toContain('width="1" height="1"');
    expect(await uploadedImageStep(f.bindings, article, f.run)).toBe(true);
    expect((await articles.get(env.DB, article.id))!.body_html.match(/<figure/g)).toHaveLength(1);
    const saved = await worker.fetch(new Request(`https://x.test/articles/${article.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body_html: article.body_html + '<img src="https://evil.test/track"><script>alert(1)</script>' }) }), f.bindings);
    expect(saved.status).toBe(200); article = (await articles.get(env.DB, article.id))!;
    expect(article.body_html).toContain(uploadedImageUrl(article.id,image.id)); expect(article.body_html).not.toContain("evil.test"); expect(article.body_html).not.toContain("<script");
    expect(await exportUploadedHtml(f.bindings, article)).toContain(`data:image/png;base64,${png}`);
    const files = unzipSync(await buildBundle(f.bindings, article));
    expect(files[uploadedImageFile(image)]).toEqual(bytes(png)); expect(strFromU8(files["article.html"]!)).toContain(`src="${uploadedImageFile(image)}"`);
    const manifest = JSON.parse(strFromU8(files["uploaded-images.json"]!)); expect(manifest[0].description).toBe(image.description); expect(strFromU8(files["uploaded-images.json"]!)).not.toContain("r2_key");
    const output = await worker.fetch(new Request(`https://x.test/articles/${article.id}/output`), f.bindings); expect(await output.text()).toContain(`data:image/png;base64,${png}`);
    const emailFiles = unzipSync(await buildBundle(f.bindings, { ...article, output_format: "email" }));
    expect(strFromU8(emailFiles["article.html"]!)).toContain('<img style="display:block;max-width:100%;height:auto"');
  });
  it("bounds temporary placement retries and uses a useful fallback without failing the draft", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) {
      fetchMock.get("https://api.anthropic.com").intercept({ path: "/v1/messages", method: "POST" }).reply(503, {});
      if (i < 2) await expect(uploadedImageStep(f.bindings, f.article, f.run)).rejects.toThrow();
      else expect(await uploadedImageStep(f.bindings, f.article, f.run)).toBe(false);
    }
    expect(await uploadedImageStep(f.bindings, f.article, f.run)).toBe(true);
    const article = (await articles.get(env.DB, f.article.id))!;
    expect(article.body_html.indexOf("<figure")).toBeGreaterThan(article.body_html.indexOf("Configure call routing"));
    expect(await uploadedImageStep(f.bindings, article, f.run)).toBe(true);
    const edited = { ...article, body_html: "<p>Manual replacement.</p>" };
    expect(await uploadedImageStep(f.bindings, edited, f.run)).toBe(true);
    expect((await articles.get(env.DB, article.id))?.body_html).toBe(article.body_html);
  });
  it("retains generated inline visuals on replay and supports Markdown, while chat keeps attachments", async () => {
    const f = await fixture(); const image = f.images[0]!;
    // Seed an existing generated illustration checkpoint; no paid generation on replay.
    const baseHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.article.body_html));
    const hash = [...new Uint8Array(baseHash)].map((b) => b.toString(16).padStart(2,"0")).join("");
    await env.ASSETS.put(`articles/${f.article.id}/inline-images/manifest.json`, JSON.stringify({ version: 1, baseHash: hash, slots: [{ afterParagraph: 1, alt: "Pilot illustration", prompt: "An optimistic planning scene", state: "ready", attempts: 1 }] }));
    await env.ASSETS.put(`articles/${f.article.id}/inline-images/1.png`, bytes(png));
    const campaign = { ...f.campaign, inline_image_count: 1 };
    expect(await inlineImageStep(f.bindings, f.article, campaign)).toBe(true);
    reply([{ imageId: image.id, afterParagraph: 2 }]);
    await uploadedImageStep(f.bindings, (await articles.get(env.DB, f.article.id))!, f.run);
    await uploadedImageStep(f.bindings, (await articles.get(env.DB, f.article.id))!, f.run);
    await inlineImageStep(f.bindings, (await articles.get(env.DB, f.article.id))!, campaign);
    await uploadedImageStep(f.bindings, (await articles.get(env.DB, f.article.id))!, f.run);
    const article = (await articles.get(env.DB, f.article.id))!;
    expect(article.body_html.match(/<figure/g)).toHaveLength(2);
    const markdownFiles = unzipSync(await buildBundle(f.bindings, { ...article, output_format: "markdown" }));
    expect(strFromU8(markdownFiles["article.md"]!)).toContain(`](${uploadedImageFile(image)})`);
    const chat = { ...article, body_html: f.article.body_html, output_format: "chat", output_body: "A short update." };
    expect(await uploadedImageStep(f.bindings, chat, f.run)).toBe(true);
    const chatFiles = unzipSync(await buildBundle(f.bindings, chat)); expect(chatFiles[uploadedImageFile(image)]).toEqual(bytes(png)); expect(strFromU8(chatFiles["article.txt"]!)).toBe("A short update.");
  });
  it("removes private upload records and bytes through durable history cleanup", async () => {
    const f = await fixture(); await runs.setState(env.DB, f.run.id, "ready");
    const key = f.images[0]!.r2_key;
    await changeHistory(f.bindings, f.user.id, [f.run.id], "delete");
    expect(await campaigns.get(env.DB, f.campaign.id)).toBeNull();
    expect((await env.DB.prepare("SELECT id FROM campaign_images WHERE campaign_id=?").bind(f.campaign.id).all()).results).toHaveLength(0);
    await env.DB.prepare("UPDATE asset_cleanup SET due_at=0").run(); await cleanDeletedAssets(f.bindings);
    expect(await env.ASSETS.head(key)).toBeNull();
  });
  it("campaign deletion durably removes inactive originals and inline assets without waiting for R2", async () => {
    const f = await fixture(); const originalKey = f.images[0]!.r2_key;
    await saveImageSelection(f.bindings, f.campaign.id, { saved: [], added: [] });
    const inline = `articles/${f.article.id}/inline-images/1.png`;
    await env.ASSETS.put(inline, bytes(png));
    const response = await worker.fetch(new Request(`https://x.test/campaigns/${f.campaign.id}/delete`, { method: "POST" }), f.bindings);
    expect(response.status).toBe(302); expect(await runs.get(env.DB, f.run.id)).toBeNull();
    expect(await env.ASSETS.head(originalKey)).not.toBeNull();
    await env.DB.prepare("UPDATE asset_cleanup SET due_at=0").run(); await cleanDeletedAssets(f.bindings);
    expect(await env.ASSETS.head(originalKey)).toBeNull(); expect(await env.ASSETS.head(inline)).toBeNull();
  });
});
