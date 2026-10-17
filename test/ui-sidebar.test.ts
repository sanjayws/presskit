import { describe, expect, it } from "vitest";
import { shell } from "../src/ui/pages";

describe("compact history navigation", () => {
  it("keeps full titles available and identifies only the active run", () => {
    const title = 'A long article title with "quotes" & details beyond forty-eight characters';
    const html = shell({ email: "writer@example.com", nonce: "test", history: [
      { id: "first", state: "ready", created_at: 2, idea: title },
      { id: "second", state: "writing", created_at: 1, idea: "Next article" },
    ] }, "Result", "<p>Article</p>", "first");
    expect(html).toContain('href="/runs/first" title="A long article title with &quot;quotes&quot; &amp; details beyond forty-eight characters" aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('<span class="s ready">ready</span>');
    expect(html).toContain('<span class="s">writing</span>');
    expect(html).toContain('href="/history">Manage</a>');
  });

  it("escapes history labels and account tooltips without creating markup", () => {
    const html = shell({ email: 'writer"<bad>@example.com', nonce: "test", history: [
      { id: "run", state: "failed", created_at: 1, idea: '<img src=x onerror="alert(1)">' },
    ] }, "Result", "");
    expect(html).toContain('title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('class="side-email" title="writer&quot;&lt;bad&gt;@example.com"');
  });

  it("provides empty-history and untitled labels", () => {
    expect(shell({ email: "writer@example.com", nonce: "test", history: [] }, "New article", "")).toContain("No runs yet.");
    expect(shell({ email: "writer@example.com", nonce: "test", history: [
      { id: "run", state: "ready", created_at: 1, idea: "  " },
    ] }, "Result", "")).toContain('title="Untitled campaign"');
  });
});
