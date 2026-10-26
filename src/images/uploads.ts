/** Private raster uploads. Client filenames, MIME declarations and asset IDs are untrusted. */
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import type { Run } from "../db/repos";

export const MAX_BUILD_IMAGES = 6;
export const MAX_IMAGE_BYTES = 3_000_000;
export const MAX_BUILD_IMAGE_BYTES = 10_000_000;
export const MAX_EMBEDDED_IMAGE_BYTES = 12_000_000;
export class EmbeddedImageLimitError extends Error { constructor() { super("Inline images exceed the 12 MB embedded-download limit. Use Download all (ZIP), upload its images to your destination media library, and replace the local image paths."); } }
export const IMAGE_ID = /^upl_[a-f0-9]{32}$/;
export type UploadRole = "hero" | "inline" | "attachment";
export interface BuildImage {
  id: string; filename: string; r2_key: string; content_type: string;
  width: number; height: number; bytes: number; description: string; role: UploadRole;
  tag?: string; use_when?: string; allow_enhance?: number; sha256?: string;
}
export interface ImageSelection { saved: BuildImage[]; added: { image: BuildImage; data: Uint8Array }[] }
export class ImageUploadError extends Error {}
const fail = (message: string): never => { throw new ImageUploadError(message); };
const field = (form: FormData, key: string) => typeof form.get(key) === "string" ? form.get(key) as string : "";
const roleOf = (value: string): UploadRole => ["hero", "inline", "attachment"].includes(value) ? value as UploadRole : fail("Choose Hero image, Inside article or Download only for each image.");
export const imageExtension = (type: string) => type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
export const uploadedImageUrl = (articleId: string, imageId: string) => `/articles/${articleId}/uploaded-images/${imageId}`;
export const uploadedImageFile = (image: BuildImage) => `uploaded-${image.id.slice(4)}.${imageExtension(image.content_type)}`;
export const imageTag = (image: BuildImage) => image.tag || `image-${image.id.slice(-6)}`;
export const enhancedImageKey = (articleId: string, image: BuildImage) => image.role === "hero" ? `articles/${articleId}/image-jobs/${image.id.replace(/^upl_/, "img_")}/featured.png` : `articles/${articleId}/uploaded-images/${image.id}-enhanced.png`;
export const enhancedImageUrl = (articleId: string, image: BuildImage) => `${uploadedImageUrl(articleId,image.id)}/enhanced.png`;
export const enhancedImageFile = (image: BuildImage) => `uploaded-${image.id.slice(4)}-enhanced.png`;
export const stripUploadedImages = (html: string) => html.replace(/<figure\b[^>]*data-presskit-upload="upl_[a-f0-9]{32}"[^>]*>[\s\S]*?<\/figure>/gi, "");
export function uploadedChannelError(images: BuildImage[], formats: string[]): string | null {
  if (formats.some((format) => format === "email" || format === "word") && images.some((image) => image.content_type === "image/webp" && image.role !== "attachment")) {
    return "Email and Word need PNG or JPEG visuals. Export your WebP as PNG/JPEG and upload that copy, or choose Download only for the WebP before continuing.";
  }
  return null;
}

/** Check raster structure and dimensions without decoding pixels or executing uploaded markup. */
export function inspectImage(data: Uint8Array): { content_type: string; width: number; height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (start: number, count: number) => new TextDecoder().decode(data.subarray(start, start + count));
  let content_type = "", width = 0, height = 0;
  if (data.length >= 45 && [137,80,78,71,13,10,26,10].every((b, i) => data[i] === b)) {
    if (view.getUint32(8) !== 13 || ascii(12, 4) !== "IHDR") fail("This PNG has an invalid header. Export a new PNG copy.");
    width = view.getUint32(16); height = view.getUint32(20);
    let p = 8, hasData = false, ended = false, chunks = 0;
    while (p + 12 <= data.length) {
      if (++chunks > 4096) fail("This PNG has too many data chunks. Export a new copy with standard image settings.");
      const size = view.getUint32(p), kind = ascii(p + 4, 4);
      if (size > data.length - p - 12) fail("This PNG is incomplete. Export a new copy.");
      if (kind === "acTL") fail("Use a still PNG image instead of an animated PNG.");
      if (kind === "IDAT" && size) hasData = true;
      p += size + 12;
      if (kind === "IEND") { ended = size === 0 && p === data.length; break; }
    }
    if (!ended || !hasData) fail("This PNG is incomplete. Export a new copy.");
    content_type = "image/png";
  } else if (data.length >= 12 && data[0] === 255 && data[1] === 216) {
    let p = 2, hasScan = false;
    while (p + 3 < data.length) {
      if (data[p++] !== 255) break;
      while (data[p] === 255) p++;
      const marker = data[p++]!;
      if (marker === 0xda) { hasScan = p + 2 < data.length && view.getUint16(p) >= 2 && p + view.getUint16(p) < data.length - 2; break; }
      if (marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (p + 2 > data.length) break;
      const length = view.getUint16(p);
      if (length < 2 || p + length > data.length) break;
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) { height = view.getUint16(p + 3); width = view.getUint16(p + 5); }
      p += length;
    }
    if (!width || !hasScan || data.at(-2) !== 255 || data.at(-1) !== 217) fail("This JPEG is incomplete or unsupported. Export a new JPEG or PNG copy.");
    content_type = "image/jpeg";
  } else if (data.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    if (view.getUint32(4, true) + 8 !== data.length) fail("This WebP is incomplete. Export a new copy.");
    let p = 12, chunks = 0;
    while (p + 8 <= data.length) {
      if (++chunks > 4096) fail("This WebP has too many data chunks. Export a new copy with standard image settings.");
      const kind = ascii(p, 4), size = view.getUint32(p + 4, true), start = p + 8;
      if (size > data.length - start) fail("This WebP is incomplete. Export a new copy.");
      if (kind === "ANIM" || kind === "ANMF" || kind === "VP8X" && (data[start]! & 2)) fail("Use a still WebP image instead of an animated WebP.");
      if (kind === "VP8 " && size >= 10 && data[start + 3] === 0x9d && data[start + 4] === 1 && data[start + 5] === 0x2a) {
        width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff;
      } else if (kind === "VP8L" && size >= 5 && data[start] === 0x2f) {
        width = 1 + ((data[start + 2]! & 0x3f) << 8 | data[start + 1]!);
        height = 1 + ((data[start + 4]! & 0xf) << 10 | data[start + 3]! << 2 | data[start + 2]! >> 6);
      }
      p = start + size + (size % 2);
    }
    if (!width || p !== data.length) fail("This WebP has incomplete image data. Export a new copy.");
    content_type = "image/webp";
  } else fail("Use a PNG, JPEG or still WebP image. SVG, GIF, HEIC and documents are not supported as uploaded images.");
  if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000) fail("Resize this image to at most 8,192 pixels per side and 24 megapixels, then upload it again.");
  return { content_type, width, height };
}

export async function campaignImages(db: D1Database, campaignId: string): Promise<BuildImage[]> {
  return (await db.prepare("SELECT id,filename,r2_key,content_type,width,height,bytes,description,role,tag,use_when,allow_enhance,sha256 FROM campaign_images WHERE campaign_id=? AND active=1 ORDER BY created_at,id").bind(campaignId).all<BuildImage>()).results;
}
export function runImages(run: Pick<Run, "uploaded_images"> | null): BuildImage[] {
  const value: unknown = JSON.parse(run?.uploaded_images || "[]");
  if (!Array.isArray(value) || value.length > MAX_BUILD_IMAGES || value.some((v) => !v || !IMAGE_ID.test(v.id) || !["image/png","image/jpeg","image/webp"].includes(v.content_type) || typeof v.r2_key !== "string" || typeof v.description !== "string" || !["hero","inline","attachment"].includes(v.role))) throw new Error("Invalid saved image selection");
  return value as BuildImage[];
}

/** All count/size/type/header checks happen before storage or paid model calls. */
export async function validateImageSelection(form: FormData, saved: BuildImage[] = []): Promise<ImageSelection> {
  const explicit = form.get("images_present") === "yes";
  const keep = form.getAll("keep_image");
  if (keep.some((id) => typeof id !== "string" || !saved.some((s) => s.id === id))) fail("A selected image is unavailable. Reopen the brief and select its saved images again.");
  const selected = saved.filter((image) => !explicit || keep.includes(image.id)).map((image) => ({ ...image,
    role: explicit ? roleOf(field(form, `image_role_${image.id}`)) : image.role,
    description: explicit ? field(form, `image_description_${image.id}`).trim() : image.description,
    tag: explicit ? field(form, `image_tag_${image.id}`).trim() || imageTag(image) : imageTag(image),
    use_when: explicit ? field(form, `image_use_when_${image.id}`).trim() : image.use_when || "",
    allow_enhance: explicit ? Number(form.get(`image_enhance_${image.id}`) === "yes") : image.allow_enhance || 0,
  }));
  const files = Array.from({ length: MAX_BUILD_IMAGES }, (_, i) => ({ file: form.get(`image_${i}`), index: i }))
    .filter((entry): entry is { file: File; index: number } => entry.file !== null && typeof entry.file !== "string" && (entry.file.size > 0 || !!entry.file.name));
  // Reject extra or repeated file fields rather than silently discarding uploads.
  const posted = [...form.entries()].filter(([key, value]) => key.startsWith("image_") && typeof value !== "string" && (value.size > 0 || !!value.name));
  if (posted.length !== files.length || selected.length + files.length > MAX_BUILD_IMAGES) fail("Choose at most 6 images per brief, including saved images. Deselect an old image before adding another.");
  if (files.some(({ file }) => !file.size || file.size > MAX_IMAGE_BYTES)) fail("Each image must contain data and be at most 3 MB (3,000,000 bytes).");
  if (selected.reduce((n, i) => n + i.bytes, 0) + files.reduce((n, i) => n + i.file.size, 0) > MAX_BUILD_IMAGE_BYTES) fail("Selected images exceed 10 MB combined. Resize them or select fewer images.");
  const added: ImageSelection["added"] = [];
  for (const { file, index } of files) {
    const role = roleOf(field(form, `image_role_${index}`) || "inline");
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) fail("Use image filenames ending in .png, .jpg, .jpeg or .webp.");
    const data = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectImage(data);
    const extensionType = /\.png$/i.test(file.name) ? "image/png" : /\.webp$/i.test(file.name) ? "image/webp" : "image/jpeg";
    if (extensionType !== inspected.content_type) fail("An image's contents do not match its filename. Export a new PNG, JPEG or WebP copy.");
    const filename = file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 160);
    const description = field(form, `image_description_${index}`).trim() || filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    const id = `upl_${crypto.randomUUID().replace(/-/g, "")}`;
    const tag = field(form, `image_tag_${index}`).trim() || `image${selected.length + added.length + 1}`;
    const use_when = field(form, `image_use_when_${index}`).trim();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((byte) => byte.toString(16).padStart(2,"0")).join("");
    added.push({ image: { id, filename, r2_key: "", ...inspected, bytes: file.size, description, role, tag, use_when, sha256, allow_enhance: Number(form.get(`image_enhance_${index}`) === "yes") }, data });
  }
  const all = [...selected, ...added.map((item) => item.image)];
  if (all.some((image) => !image.description || image.description.length > 240)) fail("Describe each image in 1–240 characters so placement and alt text are useful.");
  if (all.filter((image) => image.role === "hero").length > 1) fail("Choose only one uploaded hero image. Set other images to Inside article or Download only.");
  if (all.some((image) => !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(imageTag(image)) || (image.use_when || "").length > 240)) fail("Give each image a tag of 1–40 letters/numbers, spaces, underscores or hyphens. Keep its usage instruction to 240 characters.");
  if (new Set(all.map((image) => imageTag(image).toLowerCase())).size !== all.length) fail("Use a different tag for each selected image so the writer can identify the correct visual.");
  return { saved: selected, added };
}

/** Keep original bytes private; inactive assets remain available to immutable older run snapshots. */
export async function saveImageSelection(env: Env, campaignId: string, selection: ImageSelection): Promise<void> {
  const keys: string[] = [];
  try {
    for (const item of selection.added) {
      item.image.r2_key = `grounding/${campaignId}/images/${item.image.id}`;
      keys.push(item.image.r2_key);
      await env.ASSETS.put(item.image.r2_key, item.data, { httpMetadata: { contentType: item.image.content_type }, customMetadata: { source: "upload" } });
    }
    const statements = [env.DB.prepare("UPDATE campaign_images SET active=0 WHERE campaign_id=?").bind(campaignId)];
    for (const image of selection.saved) statements.push(env.DB.prepare("UPDATE campaign_images SET active=1,description=?,role=?,tag=?,use_when=?,allow_enhance=? WHERE id=? AND campaign_id=?").bind(image.description, image.role, imageTag(image), image.use_when || "", image.allow_enhance || 0, image.id, campaignId));
    for (const { image } of selection.added) statements.push(env.DB.prepare("INSERT INTO campaign_images (id,campaign_id,filename,r2_key,content_type,width,height,bytes,description,role,created_at,tag,use_when,allow_enhance,sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(image.id, campaignId, image.filename, image.r2_key, image.content_type, image.width, image.height, image.bytes, image.description, image.role, Date.now(), imageTag(image), image.use_when || "", image.allow_enhance || 0, image.sha256 || ""));
    await env.DB.batch(statements);
  } catch (error) { if (keys.length) await env.ASSETS.delete(keys); throw error; }
}

export async function exportUploadedHtml(env: Env, article: { id: string; run_id: string; body_html: string }, localFiles = false, embeddedBudget = { bytes: 0 }): Promise<string> {
  const run = await env.DB.prepare("SELECT uploaded_images FROM runs WHERE id=?").bind(article.run_id).first<Pick<Run,"uploaded_images">>();
  let body = article.body_html;
  for (const image of runImages(run)) {
    for (const enhanced of [true,false]) {
      const url = enhanced ? enhancedImageUrl(article.id,image) : uploadedImageUrl(article.id, image.id);
      if (!body.includes(url)) continue;
      let replacement = enhanced ? enhancedImageFile(image) : uploadedImageFile(image);
      if (!localFiles) {
        const object = await env.ASSETS.get(enhanced ? enhancedImageKey(article.id,image) : image.r2_key);
        if (!object || object.size > (enhanced ? 6000000 : MAX_IMAGE_BYTES)) throw new Error("A saved image is unavailable. Use the image downloads or try again.");
        embeddedBudget.bytes += object.size;
        if (embeddedBudget.bytes > MAX_EMBEDDED_IMAGE_BYTES) { await object.body.cancel(); throw new EmbeddedImageLimitError(); }
        const bytes = new Uint8Array(await object.arrayBuffer()); let binary = "";
        for (let p = 0; p < bytes.length; p += 8192) binary += String.fromCharCode(...bytes.subarray(p, p + 8192));
        replacement = `data:${enhanced ? "image/png" : image.content_type};base64,${btoa(binary)}`;
      }
      body = body.split(url).join(replacement);
    }
  }
  return body;
}
