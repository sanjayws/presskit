import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { channelProfile, formatWriterGuidance } from "../src/style/engine";
import { renderOutput, toChat } from "../src/content/render";
import { channelIssues } from "../src/editorial/review";
import { prepareArticle } from "../src/content/finalize";
import { buildBundle } from "../src/bundle/export";
import { users, campaigns, runs, articles } from "../src/db/repos";
import { identityFromVerifiedClaims, createSessionCookie, readSession, userFromEmail } from "../src/auth/google";

const core = { title: "Plan your migration", excerpt: "Assess the network, then pilot the move.", meta_desc: "Migration guidance.", slug: "migration", key_phrases: ["migration"], body_html: '<p>Start with <strong>network checks</strong>.</p><p><em>Run a pilot</em>, then <a href="https://example.com/guide">read the guide</a>.</p>' };

describe("destination-specific content", () => {
  it("keeps chat emphasis, paragraph breaks and visible links without HTML or truncation", () => {
    expect(toChat(core.body_html)).toBe("Start with *network checks*.\n\n_Run a pilot_, then read the guide (https://example.com/guide).");
    const large = { ...core, body_html: `<p>${"A detailed point. ".repeat(150)}Keep this ending.</p>` };
    expect(renderOutput(large.body_html, "chat", { title: large.title, keyPhrases: [] }).body).toContain("Keep this ending.");
    expect(channelIssues(large, "chat").join(" ")).toContain("1,000".replace(",", ""));
  });
  it("rejects channel violations even when the model approves the prose", () => {
    expect(channelIssues({ ...core, title: "x".repeat(61), excerpt: "x".repeat(101) }, "email")).toHaveLength(2);
    expect(channelIssues({ ...core, body_html: "<h2>Heading</h2><p>Text.</p>" }, "linkedin")).toHaveLength(1);
    expect(channelProfile("linkedin").imageSize).toBe("1024x1024");
    expect(channelProfile("email").imageSize).toBe("1536x1024");
    expect(formatWriterGuidance("chat")).toContain("1,000 characters");
  });
  it("exports email as a standalone layout with escaped subject and preview", () => {
    const email = renderOutput(core.body_html, "email", { title: '<bad "subject">', excerpt: "<img src=x>", keyPhrases: [] });
    expect(email.ext).toBe("html");
    expect(email.body).toContain('max-width:600px');
    expect(email.body).toContain("&lt;bad &quot;subject&quot;&gt;");
    expect(email.body).not.toContain("<img");
    expect(email.body).toContain('mso-hide:all');
  });
  it("does not append a long reference list to a chat message", async () => {
    const prepared = await prepareArticle(core, { input: { primaryKw: "migration", outputFormat: "chat" }, referenceLinks: [{ url: "https://example.com/unrelated", label: "Additional research" }], cta: null, signature: "" });
    expect(prepared.body_html).not.toContain("Further reading");
    expect(prepared.body_html).not.toContain("Additional research");
  });
  it("keeps email and LinkedIn exports consistent with metadata and manual edits", async () => {
    const user = await users.upsertByEmail(env.DB, "dev@example.com");
    const campaign = await campaigns.create(env.DB, { user_id: user.id, idea: "Channel exports", grounding_refs: [] });
    const run = await runs.create(env.DB, campaign.id);
    const article = await articles.create(env.DB, { ...core, key_phrases: JSON.stringify(core.key_phrases), run_id: run.id, png_r2_key: null, output_format: "email" });
    const entries = unzipSync(await buildBundle(env, article));
    expect(strFromU8(entries["email-details.txt"]!)).toContain(core.excerpt);
    expect(strFromU8(entries["article.html"]!)).toContain(core.excerpt);
    expect(strFromU8(entries["email-plain.txt"]!)).not.toContain("<p>");
    const download = await SELF.fetch(`https://x.test/articles/${article.id}/output`);
    expect(download.headers.get("content-type")).toContain("text/html");
    expect(await download.text()).toContain(core.excerpt);
    const chat = await articles.create(env.DB, { ...core, key_phrases: JSON.stringify(core.key_phrases), run_id: run.id, png_r2_key: null, output_format: "chat", output_body: "old message" });
    const saved = await SELF.fetch(`https://x.test/articles/${chat.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...core, body_html: "<p><strong>Updated message</strong> with the full ending.</p>" }) });
    expect(saved.status).toBe(200);
    expect(await (await SELF.fetch(`https://x.test/articles/${chat.id}/output`)).text()).toContain("*Updated message* with the full ending.");
  });
});

describe("domain-wide sign-in", () => {
  it("auto-provisions any verified workspace.example member without an individual allowlist", async () => {
    for (const local of ["new.writer", "second.writer"]) {
      const email = `${local}-${crypto.randomUUID()}@workspace.example`;
      expect(identityFromVerifiedClaims({ email: email.toUpperCase(), email_verified: true }, "workspace.example").email).toBe(email);
      expect((await userFromEmail(env, email)).email).toBe(email);
    }
    for (const email of ["user@other.com", "user@workspace.example.evil.test", "user@sub.workspace.example", "user@workspace.example@evil.test"]) {
      expect(() => identityFromVerifiedClaims({ email, email_verified: true }, "workspace.example")).toThrow();
    }
    expect(() => identityFromVerifiedClaims({ email: "writer@workspace.example", email_verified: false }, "workspace.example")).toThrow();
  });
  it("rechecks the permitted domain on signed sessions", async () => {
    const token = await createSessionCookie(env, "writer@other.com");
    expect(await readSession({ ...env, ALLOWED_EMAIL_DOMAIN: "workspace.example" }, token)).toBeNull();
  });
});
