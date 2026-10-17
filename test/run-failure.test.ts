import { describe, expect, it } from "vitest";
import { runFailure } from "../src/ui/run-failure";
import { readinessSummary, runProgress } from "../src/ui/pages";
import { env, SELF } from "cloudflare:test";
import { users, campaigns, runs } from "../src/db/repos";

describe("specific corrective guidance", () => {
  it.each([
    ["[ingest] grounding url returned 403: https://blocked.test", "source_access", "Upload"],
    ["[assess] OpenAI readiness check failed (401).", "provider_access", "administrator"],
    ["[topics] Anthropic 429", "provider_limit", "billing"],
    ["[write] OpenAI text request timed out or could not connect", "service_interrupted", "Resume"],
    ["Editorial review needs attention.", "editorial_findings", "Download"],
    ["[review] The editor returned invalid JSON", "generation_incomplete", "Resume"],
    ["[review] The editorial checkpoint is missing", "saved_work_missing", "new run"],
    ["[assess] OpenAI readiness check declined this request", "provider_declined", "Review"],
  ])("classifies %s without blaming unrelated sources", (error, code, action) => {
    const guidance = runFailure(error);
    expect(guidance.code).toBe(code);
    expect(guidance.actions.join(" ")).toContain(action);
    expect(JSON.stringify(guidance)).not.toContain(error);
  });
  it("escapes all generated guidance and gives a concrete next step", () => {
    const html = readinessSummary({ version: 1, fingerprint: "x", state: "needs_input", summary: "Need the study <script>alert(1)</script>",
      gaps: [{ requirement: 'Claim <img src=x onerror="alert(1)">', missing: "No result in the supplied study", action: "Upload the results table" }], checkedAt: 0 });
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
    expect(html).toContain("Next step:"); expect(html).toContain("Upload the results table");
  });
  it("does not expose raw diagnostics and does not poll an input gate", async () => {
    const user = await users.upsertByEmail(env.DB, "dev@example.com");
    const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Pilot steps", grounding_refs: [] });
    const run = await runs.create(env.DB, campaign.id);
    const html = runProgress({ email: user.email, nonce: "test", history: [] }, { ...run, state: "needs_input" });
    expect(html).not.toContain('data-run-progress="');
    expect(html).toContain("before writing");
    await runs.fail(env.DB, run.id, "[assess] OpenAI readiness check failed (401). secret-token-not-for-ui");
    const response = await SELF.fetch(`https://x.test/runs/${run.id}`);
    const failed = await response.text();
    expect(failed).toContain("administrator"); expect(failed).not.toContain("secret-token-not-for-ui");
    expect(failed).not.toContain("Check that your sources are accessible and your brief is supported by them");
  });
});
