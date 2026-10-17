import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { users, campaigns, runs, topics } from "../src/db/repos";

const DEV = "dev@example.com";

async function awaitingRun(email: string) {
  const u = await users.upsertByEmail(env.DB, email);
  const c = await campaigns.create(env.DB, {
    user_id: u.id,
    idea: "idea",
    grounding_refs: [{ kind: "url", source: "https://example.com" }],
  });
  const r = await runs.create(env.DB, c.id);
  await runs.setState(env.DB, r.id, "awaiting_topic_selection");
  await topics.createMany(env.DB, c.id, r.id, [
    { title: "A", angle: "x", summary: "s", primary_kw: "kw" },
  ]);
  return r.id;
}

describe("H-03 stage lease (exclusive claim)", () => {
  it("hands the next state an immediately claimable lease and rejects stale owners", async () => {
    const id = await awaitingRun(DEV);
    await runs.setState(env.DB, id, "writing");
    const owner = await runs.claimStage(env.DB, id, "writing", 60000);
    expect(await runs.handOff(env.DB, id, "writing", "styling", "stale-owner")).toBe(false);
    expect(await runs.handOff(env.DB, id, "writing", "styling", owner!)).toBe(true);
    expect(await runs.claimStage(env.DB, id, "styling", 60000)).toBeTruthy();
  });
  it("only one of two claims from the same state wins", async () => {
    const id = await awaitingRun(DEV);
    await runs.setState(env.DB, id, "writing");
    const [a, b] = await Promise.all([
      runs.claimStage(env.DB, id, "writing", 60_000),
      runs.claimStage(env.DB, id, "writing", 60_000),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners.length).toBe(1);
  });

  it("a released lease can be reclaimed", async () => {
    const id = await awaitingRun(DEV);
    await runs.setState(env.DB, id, "writing");
    const owner = await runs.claimStage(env.DB, id, "writing", 60_000);
    expect(owner).toBeTruthy();
    // A second claim is blocked while the lease is live...
    expect(await runs.claimStage(env.DB, id, "writing", 60_000)).toBeNull();
    // ...until the owner releases it.
    await runs.releaseStage(env.DB, id, owner!);
    expect(await runs.claimStage(env.DB, id, "writing", 60_000)).toBeTruthy();
  });
});

describe("H-03 / M-06 regeneration budget", () => {
  it("429s once the per-run regeneration limit is reached", async () => {
    const id = await awaitingRun(DEV);
    for (let i = 0; i < 5; i++) await runs.bumpRegen(env.DB, id);
    const res = await SELF.fetch(`https://x.test/runs/${id}/regenerate`, {
      method: "POST",
      redirect: "manual",
    });
    expect(res.status).toBe(429);
    // Budget exhausted: state unchanged, not rewound to drafting.
    const r = await runs.get(env.DB, id);
    expect(r!.state).toBe("awaiting_topic_selection");
  });
});
