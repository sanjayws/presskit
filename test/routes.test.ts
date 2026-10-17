import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  buildAuthUrl,
  createSessionCookie,
  readSession,
} from "../src/auth/google";
import type { Env } from "../src/env";
import worker from "../src/index";
import { campaigns, runs } from "../src/db/repos";

describe("routes (auth gate)", () => {
  it("serves /healthz without auth", async () => {
    const res = await SELF.fetch("https://x.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves the dashboard under dev auth and shows the identity", async () => {
    const res = await SELF.fetch("https://x.test/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Presskit");
    expect(html).toContain("Check brief & sources");
    expect(html).toContain("History"); // sidebar Campaigns -> History
    expect(html).toContain("dev@example.com");
    expect(html).toContain("/auth/logout");
  });
});

describe("Google sign-in flow", () => {
  it("login redirects to Google consent with the client id", async () => {
    const res = await SELF.fetch("https://x.test/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain("test-client-id.apps.googleusercontent.com");
    // CSRF state cookie is set.
    expect(res.headers.get("set-cookie") ?? "").toContain("oauth_state=");
  });

  it("callback rejects a mismatched/absent state (CSRF guard)", async () => {
    const res = await SELF.fetch(
      "https://x.test/auth/callback?code=abc&state=nope",
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid OAuth state");
  });

  it("builds an auth url that pins the allowed workspace domain", () => {
    const url = buildAuthUrl(env as unknown as Env, "st4te");
    expect(url).toContain("hd=example.com");
    expect(url).toContain("state=st4te");
    expect(url).toContain("scope=openid+email+profile");
  });

  it("round-trips a signed session cookie and rejects a bad one", async () => {
    const e = env as unknown as Env;
    const value = await createSessionCookie(e, "user@example.com");
    expect(await readSession(e, value)).toBe("user@example.com");
    expect(await readSession(e, "garbage.token.here")).toBeNull();
  });
});

describe("campaign creation validates grounding (ground or refuse)", () => {
  it("keeps a detailed brief and editorial directions intact instead of trimming their endings", async () => {
    const bindings = { ...env, DEV_AUTH_EMAIL: `detailed-${crypto.randomUUID()}@example.com` };
    const form = new FormData();
    const brief = "Describe the migration. ".repeat(180) + "Keep the final section titled Required follow-up.";
    const include = "Explain each practical step. ".repeat(80) + "Include the final readiness check.";
    form.set("idea", brief); form.set("include_ideas", include); form.set("urls", "https://example.com/research");
    const response = await worker.fetch(new Request("https://x.test/campaigns", { method: "POST", body: form }), bindings);
    expect(response.status).toBe(302);
    const id = response.headers.get("location")!.split("/").pop()!;
    const run = await runs.get(env.DB, id);
    const saved = await campaigns.get(env.DB, run!.campaign_id);
    expect(saved?.idea).toBe(brief);
    expect(saved?.include_ideas).toBe(include);
    form.set("include_ideas", "x".repeat(6001));
    const rejected = await worker.fetch(new Request("https://x.test/campaigns", { method: "POST", body: form }), bindings);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("6,000");
  });

  it("returns a helpful upload error without creating an orphan campaign when a PDF is invalid", async () => {
    const email = `pdf-${crypto.randomUUID()}@example.com`;
    const form = new FormData();
    form.set("idea", "PDF reference review");
    form.set("upload", new File(["not a PDF"], "source.pdf", { type: "application/pdf" }));
    const response = await worker.fetch(new Request("https://x.test/campaigns", { method: "POST", body: form }), { ...env, DEV_AUTH_EMAIL: email });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Supporting document:");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns c JOIN users u ON u.id = c.user_id WHERE u.email = ?").bind(email).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
  it("rejects invalid URL lines rather than silently dropping them", async () => {
    const form = new FormData();
    form.set("idea", "an idea");
    form.set("urls", "https://example.com\nnot a URL");
    const res = await SELF.fetch("https://x.test/campaigns", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("enforces brief length and supported upload extensions server-side", async () => {
    const form = new FormData();
    form.set("idea", "x".repeat(12001));
    form.set("urls", "https://example.com");
    const long = await SELF.fetch("https://x.test/campaigns", { method: "POST", body: form });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain("12,000");
    form.set("idea", "an idea");
    form.set("upload", new File(["Readable source text."], "source.exe", { type: "application/octet-stream" }));
    const unsupported = await SELF.fetch("https://x.test/campaigns", { method: "POST", body: form });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.text()).toContain("PDF, Word, Excel, PowerPoint");
  });
  it("refuses a campaign with no url and no upload", async () => {
    const form = new FormData();
    form.set("idea", "an idea");
    form.set("urls", "");
    const res = await SELF.fetch("https://x.test/campaigns", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at least one source URL or a readable supporting document");
  });
});
