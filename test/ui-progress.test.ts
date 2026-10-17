import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import worker from "../src/index";
import { campaigns, runs, users, type RunState } from "../src/db/repos";
import { runProgress } from "../src/ui/pages";
import { progressFor, RUN_PROGRESS } from "../src/ui/run-progress";

async function makeRun(ownerEmail = "dev@example.com") {
  const owner = await users.upsertByEmail(env.DB, ownerEmail);
  const campaign = await campaigns.create(env.DB, {
    user_id: owner.id,
    idea: "Private research brief",
    grounding_refs: [],
  });
  return runs.create(env.DB, campaign.id);
}

describe("steady generation progress", () => {
  it.each(["drafting_topics", "writing", "styling", "asset_gen"] as const)(
    "%s renders a background-updated progress view without document reloads",
    async (state) => {
      const run = await makeRun();
      await runs.setState(env.DB, run.id, state);
      const response = await SELF.fetch(`https://x.test/runs/${run.id}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`data-run-progress="${run.id}" data-state="${state}"`);
      expect(html).toContain(`<h1 data-progress-heading>${RUN_PROGRESS[state].heading}</h1>`);
      expect(html).toContain(`<strong data-progress-label>${RUN_PROGRESS[state].label}</strong>`);
      expect(html).toContain(`data-progress-stage="${RUN_PROGRESS[state].stage}" class="current"`);
      expect(html).toContain("Progress updates automatically without reloading the page.");
      expect(html).toContain("data-progress-connection");
      expect(html).not.toContain("data-reload-ms");
      expect(html).not.toContain("location.reload");
    },
  );

  it("does not poll a failed run or reveal raw pipeline errors", async () => {
    const run = await makeRun();
    const html = runProgress({ email: "dev@example.com", nonce: "test", history: [] }, {
      ...run, state: "failed", error: "Sensitive upstream diagnostic",
    });
    expect(html).not.toContain('data-run-progress="');
    expect(html).toContain("This run needs attention");
    expect(html).not.toContain("Sensitive upstream diagnostic");
  });

  it.each(["awaiting_topic_selection", "ready", "failed"] as const)(
    "%s is a next screen, not an in-place generation state",
    (state) => expect(progressFor(state)).toBeNull(),
  );

  it("escapes the run identifier in progress markup", async () => {
    const run = await makeRun();
    const html = runProgress({ email: "dev@example.com", nonce: "test", history: [] }, {
      ...run, id: 'run"<bad>',
    });
    expect(html).toContain('data-run-progress="run&quot;&lt;bad&gt;"');
    expect(html).not.toContain('data-run-progress="run"<bad>');
  });
});

describe("private lightweight run status", () => {
  const states: RunState[] = [
    "drafting_topics", "awaiting_topic_selection", "writing", "styling", "asset_gen", "ready", "failed",
  ];
  it.each(states)("returns only the owner's %s state without modifying the run", async (state) => {
    const run = await makeRun();
    await runs.setState(env.DB, run.id, state);
    const before = await runs.get(env.DB, run.id);
    const response = await SELF.fetch(`https://x.test/runs/${run.id}/status`, {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ state });
    expect(await runs.get(env.DB, run.id)).toEqual(before);
  });

  it("treats another owner's run exactly like a missing run", async () => {
    const run = await makeRun("another-writer@example.com");
    const other = await SELF.fetch(`https://x.test/runs/${run.id}/status`);
    const missing = await SELF.fetch("https://x.test/runs/missing/status");
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
  });

  it("returns 401 to polling requests when the session expires", async () => {
    const response = await worker.fetch(new Request("https://x.test/runs/anything/status", {
      headers: { accept: "application/json" },
    }), { ...env, DEV_AUTH_EMAIL: undefined });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("Unauthorized");
  });

  it("still redirects ordinary signed-out page navigations to login", async () => {
    const response = await worker.fetch(new Request("https://x.test/runs/anything"), {
      ...env, DEV_AUTH_EMAIL: undefined,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login");
  });
});
