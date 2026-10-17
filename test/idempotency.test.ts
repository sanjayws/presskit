import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { users, campaigns, runs } from "../src/db/repos";
import { stageWrite, stageImage } from "../src/pipeline/run";

describe("run state CAS + quotas (H-01/H-03)", () => {
  it("transition moves state exactly once", async () => {
    const u = await users.upsertByEmail(env.DB, "cas@example.com");
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r = await runs.create(env.DB, c.id); // drafting_topics
    expect(await runs.transition(env.DB, r.id, "drafting_topics", "writing")).toBe(true);
    // Second attempt from the original state must fail (already moved).
    expect(await runs.transition(env.DB, r.id, "drafting_topics", "writing")).toBe(false);
    expect((await runs.get(env.DB, r.id))?.state).toBe("writing");
  });

  it("counts only non-terminal runs as active, split by who they wait on", async () => {
    const u = await users.upsertByEmail(env.DB, "active@example.com");
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r1 = await runs.create(env.DB, c.id); // drafting_topics -> generating
    const r2 = await runs.create(env.DB, c.id);
    await runs.setState(env.DB, r2.id, "ready"); // terminal, not counted
    const r3 = await runs.create(env.DB, c.id);
    await runs.fail(env.DB, r3.id, "boom"); // terminal, not counted
    const r4 = await runs.create(env.DB, c.id); // parked at the angle picker
    await runs.setState(env.DB, r4.id, "awaiting_topic_selection");
    const act = await runs.activeCountsForUser(env.DB, u.id);
    expect(act.generating).toBe(1); // only r1
    expect(act.awaiting).toBe(1); // only r4
  });

  it("counts zero for a user with no runs", async () => {
    const u = await users.upsertByEmail(env.DB, "empty@example.com");
    const act = await runs.activeCountsForUser(env.DB, u.id);
    expect(act).toEqual({ generating: 0, awaiting: 0 });
  });
});

describe("stage idempotency guards (H-01)", () => {
  it("stageWrite is a no-op when the run is not in 'writing'", async () => {
    const u = await users.upsertByEmail(env.DB, "guard@example.com");
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r = await runs.create(env.DB, c.id); // drafting_topics, not writing
    // Must return without touching OpenAI (would throw otherwise) or creating rows.
    await expect(stageWrite(env, r.id)).resolves.toBeUndefined();
    expect((await runs.get(env.DB, r.id))?.state).toBe("drafting_topics");
  });

  it("stageImage is a no-op when the run is not in 'asset_gen'", async () => {
    const u = await users.upsertByEmail(env.DB, "guard2@example.com");
    const c = await campaigns.create(env.DB, { user_id: u.id, idea: "x", grounding_refs: [] });
    const r = await runs.create(env.DB, c.id); // drafting_topics
    await expect(stageImage(env, r.id)).resolves.toBeUndefined();
    expect((await runs.get(env.DB, r.id))?.state).toBe("drafting_topics");
  });
});
