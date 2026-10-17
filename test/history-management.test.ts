import { describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { users, campaigns, runs, articles, groundingDocs, articleProgress } from "../src/db/repos";
import { imageJobs } from "../src/db/image-jobs";
import { changeHistory, cleanDeletedAssets, listHistory } from "../src/db/history";

const filter = { view: "active" as const, group: "", search: "", page: 1 };
async function fixture(email = "dev@example.com") {
  const user = await users.upsertByEmail(env.DB, email);
  const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Phone migration brief", grounding_refs: [] });
  const run = await runs.create(env.DB, campaign.id);
  await runs.setState(env.DB, run.id, "ready");
  const article = await articles.create(env.DB, { run_id: run.id, title: "Testing before rollout", body_html: "<p>Run a pilot.</p>", excerpt: "", slug: "pilot", meta_desc: "", key_phrases: "[]", png_r2_key: null });
  return { user, campaign, run, article };
}
function post(ids: string[], action: string, extras: Record<string, string> = {}, origin?: string) {
  const body = new URLSearchParams({ action, ...extras });
  ids.forEach((id) => body.append("run_id", id));
  return SELF.fetch("https://x.test/history", { method: "POST", body, redirect: "manual", ...(origin ? { headers: { origin } } : {}) });
}

describe("content history management", () => {
  it("archives and restores without changing work, and hides archives from the sidebar", async () => {
    const f = await fixture();
    expect((await post([f.run.id], "archive")).status).toBe(303);
    expect((await runs.listForUser(env.DB, f.user.id)).some((r) => r.id === f.run.id)).toBe(false);
    expect((await listHistory(env.DB, f.user.id, { ...filter, view: "archive" })).items.map((r) => r.id)).toContain(f.run.id);
    expect((await articles.get(env.DB, f.article.id))?.body_html).toBe("<p>Run a pilot.</p>");
    expect((await SELF.fetch(`https://x.test/runs/${f.run.id}`)).status).toBe(200);
    expect((await post([f.run.id], "restore")).status).toBe(303);
    expect((await runs.listForUser(env.DB, f.user.id)).map((r) => r.id)).toContain(f.run.id);
  });
  it("moves selected runs into named groups, supports search and clears grouping", async () => {
    const f = await fixture();
    await changeHistory(env, f.user.id, [f.run.id], "group", "  Launch   research  ");
    const page = await listHistory(env.DB, f.user.id, { ...filter, group: "Launch research", search: "Testing" });
    expect(page.items.map((r) => r.id)).toEqual([f.run.id]);
    expect(page.groups).toContain("Launch research");
    expect((await listHistory(env.DB, f.user.id, { ...filter, search: "no such title" })).total).toBe(0);
    await changeHistory(env, f.user.id, [f.run.id], "group", "");
    expect((await listHistory(env.DB, f.user.id, filter)).items.find((r) => r.id === f.run.id)?.history_group).toBe("");
  });
  it("rejects mixed-owner selections, cross-origin actions and oversized inputs", async () => {
    const f = await fixture(); const other = await fixture("other@workspace.example");
    expect((await post([f.run.id, other.run.id], "archive")).status).toBe(404);
    expect((await runs.listForUser(env.DB, f.user.id)).map((r) => r.id)).toContain(f.run.id);
    expect((await post([f.run.id], "archive", {}, "https://evil.test")).status).toBe(403);
    expect((await post([], "archive")).status).toBe(400);
    expect((await post([f.run.id], "group", { target_group: "x".repeat(81) })).status).toBe(400);
    expect((await SELF.fetch("https://x.test/history").then((r) => r.text()))).not.toContain(other.run.id);
  });
  it("requires a separate deletion confirmation and preserves other runs and their shared sources", async () => {
    const f = await fixture(); const sibling = await runs.create(env.DB, f.campaign.id);
    const doc = await groundingDocs.create(env.DB, { campaign_id: f.campaign.id, kind: "upload", source: "evidence.txt", r2_key: `grounding/${f.campaign.id}/evidence`, hash: "h" });
    await articleProgress.save(env.DB, f.run.id, "top_x", "{}", "[]");
    const confirmation = await post([f.run.id], "delete");
    expect(confirmation.status).toBe(200);
    expect(await confirmation.text()).toContain("Permanently delete 1 item");
    expect(await runs.get(env.DB, f.run.id)).not.toBeNull();
    expect((await post([f.run.id], "delete", { confirmed: "delete" })).status).toBe(303);
    expect(await runs.get(env.DB, f.run.id)).toBeNull();
    expect(await articles.get(env.DB, f.article.id)).toBeNull();
    expect(await articleProgress.load(env.DB, f.run.id, "top_x")).toBeNull();
    expect(await runs.get(env.DB, sibling.id)).not.toBeNull();
    expect(await campaigns.get(env.DB, f.campaign.id)).not.toBeNull();
    expect((await groundingDocs.listForCampaign(env.DB, f.campaign.id)).map((d) => d.id)).toContain(doc.id);
  });
  it("removes the final brief and queues durable paged cleanup including older image versions", async () => {
    const f = await fixture();
    const keys = [`articles/${f.article.id}/featured.png`, `articles/${f.article.id}/image-jobs/old/featured.png`, `runs/${f.run.id}/sources.json`, `grounding/${f.campaign.id}/uploads/raw`];
    for (const key of keys) await env.ASSETS.put(key, "fixture");
    await changeHistory(env, f.user.id, [f.run.id], "delete");
    expect(await campaigns.get(env.DB, f.campaign.id)).toBeNull();
    expect((await SELF.fetch(`https://x.test/articles/${f.article.id}/featured.png`)).status).toBe(404);
    await cleanDeletedAssets(env); // Delay protects against an in-flight export write.
    expect(await env.ASSETS.head(keys[0]!)).not.toBeNull();
    await env.DB.prepare("UPDATE asset_cleanup SET due_at=0").run();
    const failing = vi.spyOn(env.ASSETS, "list").mockRejectedValueOnce(new Error("temporary R2 outage"));
    await cleanDeletedAssets(env); failing.mockRestore();
    expect((await env.DB.prepare("SELECT SUM(attempts) AS n FROM asset_cleanup").first<{n: number}>())!.n).toBeGreaterThan(0);
    await env.DB.prepare("UPDATE asset_cleanup SET due_at=0").run();
    await cleanDeletedAssets(env);
    for (const key of keys) expect(await env.ASSETS.head(key)).toBeNull();
  });
  it("blocks deletion during generation or an image refresh, while allowing archive", async () => {
    const f = await fixture();
    await runs.setState(env.DB, f.run.id, "writing");
    expect((await post([f.run.id], "delete", { confirmed: "delete" })).status).toBe(409);
    expect((await post([f.run.id], "archive")).status).toBe(303);
    expect((await runs.get(env.DB, f.run.id))?.state).toBe("writing");
    await runs.setState(env.DB, f.run.id, "ready");
    await imageJobs.request(env.DB, f.article.id, "new", null);
    expect((await post([f.run.id], "delete", { confirmed: "delete" })).status).toBe(409);
    expect(await articles.get(env.DB, f.article.id)).not.toBeNull();
  });
  it("does not partly delete a selection when another run starts after the precheck", async () => {
    const f = await fixture(); const other = await fixture();
    const batch = env.DB.batch.bind(env.DB);
    const race = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await runs.setState(env.DB, other.run.id, "writing");
      return batch(statements);
    });
    try {
      await expect(changeHistory(env, f.user.id, [f.run.id, other.run.id], "delete")).rejects.toThrow(/Nothing in this selection was deleted/);
    } finally { race.mockRestore(); }
    expect(await runs.get(env.DB, f.run.id)).not.toBeNull();
    expect(await articles.get(env.DB, f.article.id)).not.toBeNull();
    expect(await runs.get(env.DB, other.run.id)).not.toBeNull();
    expect(await env.DB.prepare("SELECT prefix FROM asset_cleanup WHERE prefix=?").bind(`articles/${f.article.id}/`).first()).toBeNull();
    await runs.setState(env.DB, other.run.id, "ready");
    expect(await changeHistory(env, f.user.id, [f.run.id, other.run.id], "delete")).toBe(2);
    expect(await runs.get(env.DB, f.run.id)).toBeNull();
    expect(await runs.get(env.DB, other.run.id)).toBeNull();
  });
  it("finishes cleanup across multiple R2 pages without skipping old image copies", async () => {
    const f = await fixture();
    const prefix = `articles/${f.article.id}/`;
    await Promise.all(Array.from({ length: 105 }, (_, i) => env.ASSETS.put(`${prefix}image-jobs/${String(i).padStart(3, "0")}/featured.png`, "fixture")));
    await changeHistory(env, f.user.id, [f.run.id], "delete");
    await env.DB.prepare("UPDATE asset_cleanup SET due_at=0 WHERE prefix=?").bind(prefix).run();
    await cleanDeletedAssets(env);
    expect((await env.ASSETS.list({ prefix })).objects).toHaveLength(5);
    await cleanDeletedAssets(env);
    expect((await env.ASSETS.list({ prefix })).objects).toHaveLength(0);
    expect((await env.DB.prepare("SELECT sweep FROM asset_cleanup WHERE prefix=?").bind(prefix).first<{sweep: number}>())?.sweep).toBe(1);
    // A delayed export completes after the initial pass; the final sweep removes it.
    await env.ASSETS.put(`${prefix}bundle.zip`, "late export");
    await env.DB.prepare("UPDATE asset_cleanup SET due_at=0 WHERE prefix=?").bind(prefix).run();
    await cleanDeletedAssets(env);
    expect((await env.ASSETS.list({ prefix })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT prefix FROM asset_cleanup WHERE prefix=?").bind(prefix).first()).toBeNull();
  });
  it("paginates beyond the sidebar's 50 entries and safely escapes group names", async () => {
    const user = await users.upsertByEmail(env.DB, "dev@example.com");
    const before = (await listHistory(env.DB, user.id, filter)).total;
    const f = await fixture();
    await Promise.all(Array.from({ length: 50 }, () => runs.create(env.DB, f.campaign.id)));
    const second = await listHistory(env.DB, f.user.id, { ...filter, page: 2 });
    expect(second.total - before).toBe(51); expect(second.items).toHaveLength(Math.min(50, second.total - 50));
    expect((await listHistory(env.DB, f.user.id, { ...filter, page: 99999 })).filter.page).toBe(2);
    await changeHistory(env, f.user.id, [f.run.id], "group", '<img src=x onerror="alert(1)">');
    const html = await SELF.fetch("https://x.test/history?view=all").then((r) => r.text());
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
    expect(html).toContain("page=2");
  });
});
