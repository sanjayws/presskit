/** Upload requests only save bytes; extraction happens in the queue. */
import { groundingDocs } from "../db/repos";
import type { Env } from "../env";
import { ingestUpload, uploadText } from "./ingest";
import { isTransientFailure } from "../errors";
import { MAX_SOURCE_BYTES, SOURCE_EXTENSIONS } from "./documents";
export interface SourceUpload { id: string; campaign_id: string; filename: string; r2_key: string; state: string; doc_id: string | null; error: string | null }
export async function saveSourceUpload(env: Env, campaignId: string, file: File): Promise<string> {
  if (!SOURCE_EXTENSIONS.test(file.name) || file.size > MAX_SOURCE_BYTES) throw new Error("Use PDF, Word, Excel, PowerPoint or text files up to 10 MB.");
  const id = crypto.randomUUID();
  const extension = file.name.slice(file.name.lastIndexOf("."));
  const filename = file.name.length > 240 ? file.name.slice(0, 240 - extension.length) + extension : file.name;
  const key = `grounding/${campaignId}/uploads/${id}`;
  const bytes = await file.arrayBuffer();
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
  if (/\.pdf$/i.test(file.name) && new TextDecoder().decode(prefix).slice(0, 5) !== "%PDF-") throw new Error("The PDF is invalid. Upload a readable PDF copy.");
  if (/\.(docx|xlsx|pptx)$/i.test(file.name) && (prefix[0] !== 0x50 || prefix[1] !== 0x4b)) throw new Error("This Office document has an invalid file header. Export a new copy.");
  if (/\.(doc|xls|ppt)$/i.test(file.name) && (bytes.byteLength < 512 || ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, i) => prefix[i] === byte))) {
    throw new Error("This Office document has an invalid file header. Export a new copy.");
  }
  if (!/\.(pdf|docx?|xlsx?|pptx?)$/i.test(file.name)) uploadText(new TextDecoder().decode(bytes));
  await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  try {
    await env.DB.prepare("INSERT INTO source_uploads(id,campaign_id,filename,r2_key,created_at) VALUES (?,?,?,?,?)")
      .bind(id, campaignId, filename, key, Date.now()).run();
  } catch (error) { await env.ASSETS.delete(key); throw error; }
  return id;
}
export async function sourceUploads(env: Env, campaignId: string): Promise<SourceUpload[]> {
  return (await env.DB.prepare("SELECT * FROM source_uploads WHERE campaign_id=? ORDER BY created_at").bind(campaignId).all<SourceUpload>()).results;
}
export async function extractNextUpload(env: Env, campaignId: string, allowedIds?: string[]): Promise<boolean> {
  const pending = (await sourceUploads(env, campaignId)).find((item) => item.state === "pending" && (!allowedIds || allowedIds.includes(item.id)));
  if (!pending) return false;
  try {
    const object = await env.ASSETS.get(pending.r2_key);
    if (!object || object.size > MAX_SOURCE_BYTES) throw new Error("The saved upload is unavailable or too large. Upload the document again.");
    const bytes = await object.arrayBuffer();
    const binary = /\.(pdf|docx?|xlsx?|pptx?)$/i.test(pending.filename);
    const result = await ingestUpload(env, campaignId, pending.filename, binary ? bytes : new TextDecoder().decode(bytes));
    await env.DB.prepare("UPDATE source_uploads SET state='loaded',doc_id=?,error=NULL WHERE id=?").bind(result.doc.id, pending.id).run();
  } catch (error) {
    if (isTransientFailure(error)) throw error;
    const message = error instanceof Error && /document|PDF|Office|PowerPoint|slide|upload|readable/i.test(error.message)
      ? error.message.slice(0, 300) : "The document could not be read. Upload an unprotected PDF or text copy.";
    await env.DB.prepare("UPDATE source_uploads SET state='unavailable',error=? WHERE id=?").bind(message, pending.id).run();
  }
  return true;
}

export interface SavedSourceDocument { filename: string; status: string; docId: string | null }
/** Include uploads saved before queued extraction was introduced, without duplicates. */
export async function savedSourceDocuments(env: Env, campaignId: string): Promise<SavedSourceDocument[]> {
  const [uploads, docs] = await Promise.all([sourceUploads(env, campaignId), groundingDocs.listForCampaign(env.DB, campaignId)]);
  return [
    ...uploads.map((upload) => ({ filename: upload.filename, status: upload.state, docId: upload.doc_id })),
    ...docs.filter((doc) => doc.kind === "upload" && !uploads.some((upload) => upload.doc_id === doc.id))
      .map((doc) => ({ filename: doc.source, status: "loaded", docId: doc.id })),
  ];
}
