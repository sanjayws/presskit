import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/content/sanitize";

describe("HTML sanitizer (C-02 stored XSS defense)", () => {
  it("removes script elements and their content", async () => {
    const out = await sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain("ok");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("strips event-handler and style attributes", async () => {
    const out = await sanitizeHtml('<p onclick="steal()" style="x">hi</p>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("steal");
    expect(out).not.toMatch(/style=/i);
    expect(out).toContain("hi");
  });

  it("drops javascript: hrefs but keeps safe links", async () => {
    const out = await sanitizeHtml(
      '<a href="javascript:alert(1)">x</a><a href="https://ok.test">y</a>',
    );
    expect(out).not.toContain("javascript:");
    expect(out).toContain("https://ok.test");
    expect(out).toContain('rel="nofollow noopener noreferrer"');
  });

  it("removes svg/iframe/object and unwraps unknown tags", async () => {
    const out = await sanitizeHtml(
      '<svg><text>x</text></svg><iframe src="evil"></iframe><marquee>keep me</marquee>',
    );
    expect(out.toLowerCase()).not.toContain("<svg");
    expect(out.toLowerCase()).not.toContain("<iframe");
    expect(out.toLowerCase()).not.toContain("<marquee");
    expect(out).toContain("keep me"); // unknown tag unwrapped, text kept
  });

  it("keeps allowed structural tags and tables", async () => {
    const out = await sanitizeHtml(
      "<h2>T</h2><p>p</p><ul><li>i</li></ul><table><tr><td>c</td></tr></table>",
    );
    expect(out).toContain("<h2>T</h2>");
    expect(out).toContain("<li>i</li>");
    expect(out).toContain("<td>c</td>");
  });
});
