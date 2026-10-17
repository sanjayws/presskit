import { channelBudgetError } from "../src/content/channel-budget";
import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { campaigns, runs, topics, users } from "../src/db/repos";
import { selectedChannels, submittedChannels } from "../src/style/channels";
import { editCampaign, topicSelect } from "../src/ui/pages";

describe("multiple channel selection", () => {
  it("deduplicates the primary channel and preserves legacy defaults", () => {
    expect(selectedChannels("chat")).toEqual(["chat"]);
    expect(selectedChannels("html", '["html","chat"]')).toEqual(["html", "chat"]);
    const form = new FormData(); form.set("output_format", "html"); form.append("output_formats", "chat"); form.append("output_formats", "html");
    expect(submittedChannels(form)).toEqual(["html", "chat"]);
  });
  it("rejects impossible fixed-text budgets before paying for generation", () => {
    expect(channelBudgetError({ max_words: 200, reference_links: JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ url: `https://example.com/${i}`, label: "word ".repeat(30) }))), signature: "word ".repeat(20), cta: "", cta_action: "", cta_target: "" }, ["html", "chat"])).toContain("leave too little room");
  });
  it("freezes requested channels on the run and rejects invalid or excessive targets before writing", async () => {
    const user = await users.upsertByEmail(env.DB, "dev@example.com");
    const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Guide and teaser", grounding_refs: [], output_format: "html", output_formats: '["html","chat"]' });
    const run = await runs.create(env.DB, campaign.id); await runs.setState(env.DB, run.id, "awaiting_topic_selection");
    const list = await topics.createMany(env.DB, campaign.id, run.id, [{ title: "Guide", angle: "Practical", primary_kw: "guide" }]);
    const form = new FormData(); form.set("topic", list[0]!.id); form.set("output_format", "html");
    for (const format of ["email", "chat", "linkedin", "plain"]) form.append("output_formats", format);
    expect((await SELF.fetch(`https://x.test/runs/${run.id}/select`, { method: "POST", body: form, redirect: "manual" })).status).toBe(400);
    form.delete("output_formats"); form.append("output_formats", "bogus");
    expect((await SELF.fetch(`https://x.test/runs/${run.id}/select`, { method: "POST", body: form, redirect: "manual" })).status).toBe(400);
    expect((await runs.get(env.DB, run.id))?.state).toBe("awaiting_topic_selection");
    form.set("output_formats", "chat");
    expect((await SELF.fetch(`https://x.test/runs/${run.id}/select`, { method: "POST", body: form, redirect: "manual" })).status).toBe(302);
    expect(JSON.parse((await runs.get(env.DB, run.id))!.output_formats!)).toEqual(["html", "chat"]);
    await campaigns.update(env.DB, campaign.id, { output_formats: '["email"]' });
    expect(JSON.parse((await runs.get(env.DB, run.id))!.output_formats!)).toEqual(["html", "chat"]);
    const nav = { email: user.email, nonce: "test", history: [] };
    expect(topicSelect(nav, run, list, [], "html", null, '["html","chat"]')).toContain('value="chat" checked');
    expect(editCampaign(nav, campaign)).toContain('value="chat" checked');
    await runs.setState(env.DB, run.id, "ready");
  });
});
