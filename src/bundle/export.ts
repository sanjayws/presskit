import { articleSchemaStarter, seoDraftReview } from "../seo/review";
import { runs } from "../db/repos";
import { imageExtension, runImages, uploadedImageFile, MAX_IMAGE_BYTES, enhancedImageKey, enhancedImageFile, imageTag } from "../images/uploads";
import { loadVisual, visualBody } from "../images/vision";
import { exportInlineHtml, loadInline, inlineKey, inlineKind } from "../images/inline";
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

export const BUNDLE_VERSION = "visual-context-2026-10-26.1";

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
<style>img{max-width:100%;height:auto}figure{margin:1.5em 0}</style>
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
  article = { ...article, body_html: await exportInlineHtml(env, article, true) };
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
      !isRichFormat(format) && format !== "markdown" && article.output_body
        ? { body: article.output_body, ext: "txt" }
        : renderOutput(article.body_html, format, {
            keyPhrases: meta.key_phrases,
            title: article.title,
            excerpt: article.excerpt,
            maxWords: Number.MAX_SAFE_INTEGER,
          });
    mainName = `article.${rendered.ext}`;
    mainBody = rendered.body;
  }

  const run = await runs.get(env.DB, article.run_id);
  const seoContext = { outputFormat: format, writingMode: run?.writing_mode };
  const seoReview = seoDraftReview(article, seoContext);
  const files: Zippable = {
    [mainName]: strToU8(mainBody),
    "meta.json": strToU8(JSON.stringify(meta, null, 2)),
  };
  if (seoReview.applicable) {
    files["seo-checklist.json"] = strToU8(JSON.stringify(seoReview, null, 2));
    const schema = articleSchemaStarter(article, seoContext);
    if (schema) files["article-schema.json"] = strToU8(JSON.stringify(schema, null, 2).replace(/</g, "\\u003c"));
    files["seo-publishing.txt"] = strToU8(`Optional draft suggestions, not a ranking score or generation gate.\n${seoReview.publishing.join("\n")}\n${schema ? "article-schema.json is an incomplete Article JSON-LD starter. Add only true publishing-site facts (public URL/image, author, publisher and dates) before validation. If the CMS already generates Article schema, configure that instead of creating duplicate/conflicting markup. No FAQ/HowTo rich-result promises, fabricated reviews or ranking guarantees.\n" : ""}`);
  }
  if (format === "email") {
    files["email-details.txt"] = strToU8(`Subject: ${article.title}\nPreview text: ${article.excerpt}\n\nImport article.html into your email platform. Upload the featured image and inline image files to its image library and display them up to 600 pixels wide, preserving aspect ratio. Add your sender details and platform unsubscribe footer. Send a test email before sending to your audience.\n`);
    files["email-plain.txt"] = strToU8(renderOutput(article.body_html, "plain", { title: article.title, keyPhrases: phrases }).body);
  }
  if (format === "linkedin") files["linkedin-rich.html"] = strToU8(article.body_html);

  if (article.png_r2_key) {
    const png = await env.ASSETS.get(article.png_r2_key);
    if (png) files[`featured.${imageExtension(png.httpMetadata?.contentType || "image/png")}`] = [new Uint8Array(await png.arrayBuffer()), { level: 0 }];
  }
  const brief = await env.ASSETS.get(articleImageBriefKey(article));
  if (brief && brief.size <= 32_000) {
    files["image-brief.json"] = new Uint8Array(await brief.arrayBuffer());
  }

  const inline = await loadInline(env, article.id);
  for (const [i, slot] of (inline?.slots || []).entries()) {
    if (slot.state !== "ready") continue;
    const object = await env.ASSETS.get(inlineKey(article.id, i + 1, inlineKind(slot)));
    if (object && object.size <= 6000000) files[`inline-${i + 1}.${inlineKind(slot)}`] = [new Uint8Array(await object.arrayBuffer()), { level: 0 }];
  }
  if (inline?.slots.length) files["inline-images.txt"] = strToU8("Inline visuals are included as inline-N.png or inline-N.svg. Keep these alongside the article file, or upload them to your website/email media library and replace the image paths. They are generated illustrations, not documentary evidence.\n");
  const uploads = runImages(run);
  if (uploads.length) {
    for (const image of uploads) {
      const object = await env.ASSETS.get(image.r2_key);
      if (!object || object.size > MAX_IMAGE_BYTES) throw new Error("An uploaded image is unavailable. Try downloading again.");
      files[uploadedImageFile(image)] = [new Uint8Array(await object.arrayBuffer()), { level: 0 }];
      const enhanced = image.allow_enhance ? await env.ASSETS.get(enhancedImageKey(article.id,image)) : null;
      if (enhanced && enhanced.size<=6000000) files[enhancedImageFile(image)] = [new Uint8Array(await enhanced.arrayBuffer()),{level:0}];
      const reading = await loadVisual(env,image);
      if (reading?.state==="ready" && reading.reading) files[`visual-notes-${image.id.slice(4)}.md`] = strToU8(visualBody(reading.reading));
    }
    files["uploaded-images.json"] = strToU8(JSON.stringify(uploads.map((image) => ({ file: uploadedImageFile(image), tag:imageTag(image),useWhen:image.use_when || "",enhancementAllowed:Boolean(image.allow_enhance),originalFilename: image.filename, description: image.description, role: image.role, width: image.width, height: image.height, contentType: image.content_type })), null, 2));
    files["uploaded-images.txt"] = strToU8("Your originals, tags, descriptions and usage directions are listed in uploaded-images.json. Available visual-notes-*.md files contain AI readings of ORIGINAL pixels/visible text, not independent verification of feature operation or compliance. Available *-enhanced.png files are separately generated presentation edits: review text and UI against the original before use. Inside-article placement is supported for HTML, Markdown, email and Word; other channels keep separate attachments. Upload images to the destination media library and replace local paths. Original files are not cropped, resized or redacted; check privacy, permissions and destination previews before publishing.\n");
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
