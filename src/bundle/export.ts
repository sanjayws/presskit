/**
 * "Download all" bundle. Includes the chosen article format, metadata, and
 * available featured PNG/creative brief. Nothing leaves the app except by the user's
 * own download action.
 */
import { zipSync, strToU8, type Zippable } from "fflate";
import type { Env } from "../env";
import type { Article } from "../db/repos";
import { isOutputFormat } from "../style/engine";
import { renderOutput, isRichFormat } from "../content/render";
import { articleImageBriefKey } from "../images/assets";

export interface BundleMeta {
  title: string;
  slug: string;
  meta_desc: string;
  excerpt: string;
  /** Single comma-free phrase for Yoast's Focus keyphrase box (first key phrase). */
  focus_keyphrase: string;
  key_phrases: string[];
  output_format: string;
}

/** Wrap the stored body HTML in a minimal standalone document. */
export function articleHtmlDocument(article: Article): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(article.title)}</title>
<meta name="description" content="${escapeHtml(article.meta_desc)}">
</head>
<body>
<article>
${article.body_html}
</article>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Assemble the zip bytes for one article. Fetches private assets from R2. */
export async function buildBundle(env: Env, article: Article): Promise<Uint8Array> {
  const format = isOutputFormat(article.output_format) ? article.output_format : "html";
  const phrases = safeArray(article.key_phrases);
  const meta: BundleMeta = {
    title: article.title,
    slug: article.slug,
    meta_desc: article.meta_desc,
    excerpt: article.excerpt,
    focus_keyphrase: phrases[0] ?? "",
    key_phrases: phrases,
    output_format: format,
  };

  // The main article file matches the chosen output format, so the archive never
  // contradicts the platform the run targeted (M-02). HTML keeps its nice
  // standalone document wrapper; other formats serialize deterministically.
  let mainName = "article.html";
  let mainBody = articleHtmlDocument(article);
  if (format !== "html") {
    const rendered =
      !isRichFormat(format) && article.output_body
        ? { body: article.output_body, ext: format === "markdown" ? "md" : "txt" }
        : renderOutput(article.body_html, format, {
            keyPhrases: meta.key_phrases,
            title: article.title,
            excerpt: article.excerpt,
            maxWords: Number.MAX_SAFE_INTEGER,
          });
    mainName = `article.${rendered.ext}`;
    mainBody = rendered.body;
  }

  const files: Zippable = {
    [mainName]: strToU8(mainBody),
    "meta.json": strToU8(JSON.stringify(meta, null, 2)),
  };
  if (format === "email") {
    files["email-details.txt"] = strToU8(`Subject: ${article.title}\nPreview text: ${article.excerpt}\n\nImport article.html into your email platform. Upload featured.png to its image library and display it up to 600 pixels wide. Add your sender details and platform unsubscribe footer. Send a test email before sending to your audience.\n`);
    files["email-plain.txt"] = strToU8(renderOutput(article.body_html, "plain", { title: article.title, keyPhrases: phrases }).body);
  }
  if (format === "linkedin") files["linkedin-rich.html"] = strToU8(article.body_html);

  if (article.png_r2_key) {
    const png = await env.ASSETS.get(article.png_r2_key);
    if (png) files["featured.png"] = new Uint8Array(await png.arrayBuffer());
  }
  const brief = await env.ASSETS.get(articleImageBriefKey(article));
  if (brief && brief.size <= 32_000) {
    files["image-brief.json"] = new Uint8Array(await brief.arrayBuffer());
  }

  return zipSync(files, { level: 6 });
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
