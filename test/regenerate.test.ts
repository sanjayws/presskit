import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { users, campaigns, runs, topics } from "../src/db/repos";

const DEV = "dev@example.com"; // DEV_AUTH_EMAIL the test worker authenticates as

async function makeAwaitingRun(ownerEmail: string) {
  const u = await users.upsertByEmail(env.DB, ownerEmail);
  const c = await campaigns.create(env.DB, {
    user_id: u.id,
    idea: "an idea",
    grounding_refs: [{ kind: "url", source: "https://example.com" }],
  });
  const r = await runs.create(env.DB, c.id);
  await runs.setState(env.DB, r.id, "awaiting_topic_selection");
  await topics.createMany(env.DB, c.id, r.id, [
    { title: "Angle A", angle: "cost", summary: "Covers cost.", primary_kw: "kw a" },
    { title: "Angle B", angle: "howto", summary: "A how-to.", primary_kw: "kw b" },
  ]);
  return r.id;
}

describe("two-step flow: topic summary + regenerate", () => {
  it("persists a per-topic summary", async () => {
    const runId = await makeAwaitingRun(DEV);
    const list = await topics.listForRun(env.DB, runId);
    expect(list.map((t) => t.summary).sort()).toEqual(["A how-to.", "Covers cost."]);
  });

  it("rewinds the run to drafting_topics on regenerate", async () => {
    const runId = await makeAwaitingRun(DEV);
    const res = await SELF.fetch(`https://x.test/runs/${runId}/regenerate`, {
      method: "POST",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const r = await runs.get(env.DB, runId);
    expect(r!.state).toBe("drafting_topics");
  });

  it("404s regenerate on another user's run", async () => {
    const other = await makeAwaitingRun("stranger-regen@example.com");
    const res = await SELF.fetch(`https://x.test/runs/${other}/regenerate`, {
      method: "POST",
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    const r = await runs.get(env.DB, other);
    expect(r!.state).toBe("awaiting_topic_selection");
  });
});
