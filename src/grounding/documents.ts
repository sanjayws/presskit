/** Extract document text, never execute macros or follow embedded links. */
import { unzipSync, strFromU8 } from "fflate";
import { Buffer } from "node:buffer";
import WordExtractor from "word-extractor";
import PPT from "../../vendor/ppt/ppt.cjs";
import type { Env } from "../env";
import { RetryableError } from "../errors";
import { extractDocumentMarkdown } from "../openai/extract";
import { MAX_SOURCE_BYTES, MAX_EXTRACTED_CHARS } from "./limits";
export { MAX_SOURCE_BYTES } from "./limits";

export const SOURCE_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|txt|html?|csv|md)$/i;
export const OFFICE_MIMES: Record<string, string> = {
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export function completeText(text: string): string {
  if (text.length > MAX_EXTRACTED_CHARS) throw new Error("This document is too long to extract completely. Upload the relevant pages, slides or sheets.");
  if (text.trim().length < 40) throw new Error("This document contains too little readable text. Upload a readable copy or export it as PDF.");
  return text.trim();
}

const entity = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, (match) => {
  const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  if (named[match]) return named[match];
  const n = match.startsWith("&#x") ? parseInt(match.slice(3, -1), 16) : Number(match.slice(2, -1));
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
});
const attr = (tag: string, name: string) => entity(new RegExp(`\\b${name}=["']([^"']+)["']`).exec(tag)?.[1] || "");

/** Bounded ZIP inflation; presentation order comes from relationships, not filenames. */
export function extractPptx(bytes: Uint8Array): string {
  let total = 0, entries = 0;
  const files = unzipSync(bytes, { filter: (file) => {
    if (++entries > 1000 || file.originalSize > 8_000_000 || (total += file.originalSize) > 30_000_000) throw new Error("Office archive exceeds extraction limits");
    return /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/.test(file.name);
  } });
  const xml = (path: string) => files[path] ? strFromU8(files[path]) : "";
  const relationships = (path: string) => new Map([...xml(path).matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [attr(tag, "Id"), attr(tag, "Target")]));
  const order = [...xml("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*>/g)].map(([tag]) => attr(tag, "r:id"));
  const rels = relationships("ppt/_rels/presentation.xml.rels");
  if (!order.length) throw new Error("PowerPoint slide order could not be read. Export a PDF copy.");
  const textOf = (text: string) => [...text.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((t) => entity(t[1]!)).join("")).filter(Boolean).join("\n");
  const slides = order.map((id, index) => {
    const target = rels.get(id) || "";
    const path = target.startsWith("/ppt/") ? target.slice(1) : `ppt/${target}`;
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(path) || !files[path]) throw new Error("A PowerPoint slide could not be extracted. Export a PDF copy.");
    const slide = textOf(xml(path));
    const notePath = [...relationships(path.replace("slides/", "slides/_rels/") + ".rels").values()].find((value) => /^\.\.\/notesSlides\/notesSlide\d+\.xml$/.test(value));
    const notes = notePath ? textOf(xml(`ppt/${notePath.slice(3)}`)) : "";
    return `Slide ${index + 1}\n${slide || "[No extractable slide text; check the original visual]"}${notes ? `\nSpeaker notes:\n${notes}` : ""}`;
  });
  if (!slides.some((text) => !text.includes("[No extractable"))) throw new Error("These slides contain no readable text. Upload a PDF copy for visual extraction.");
  return completeText(slides.join("\n\n"));
}

export async function extractOffice(env: Env, filename: string, bytes: Uint8Array): Promise<string> {
  // Parse full sheets locally/by binding: native file-input spreadsheet handling
  // only exposes the first 1,000 rows and is unsuitable for faithful extraction.
  const text = await extractOfficeText(env, filename, bytes);
  return extractDocumentMarkdown(env, { filename, text });
}

export async function extractOfficeText(env: Env, filename: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("Document exceeds the 10 MB size cap");
  const extension = filename.split(".").pop()!.toLowerCase();
  try {
    if (extension === "pptx") return extractPptx(bytes);
    if (extension === "doc" || extension === "ppt") {
      if (bytes.length < 512 || ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, i) => bytes[i] === byte)) throw new Error("Invalid legacy Office file");
      if (extension === "doc") {
        const document = await new WordExtractor().extract(Buffer.from(bytes));
        return completeText([document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getTextboxes()].filter(Boolean).join("\n\n"));
      }
      const slides = PPT.utils.to_text(PPT.readBuffer(Buffer.from(bytes)));
      if (!slides.every((slide) => typeof slide === "string")) throw new Error("Invalid slide text");
      return completeText(slides.map((slide, i) => `Slide ${i + 1}\n${slide}`).join("\n\n"));
    }
  } catch (error) {
    if (error instanceof Error && /too long|limits|readable|slide|PDF/.test(error.message)) throw error;
    throw new Error("This Office file could not be read. Remove password protection or export a PDF copy.");
  }
  if (!env.DOCUMENTS) throw new Error("Document conversion is not configured");
  let result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      env.DOCUMENTS.toMarkdown({ name: filename, blob: new Blob([bytes], { type: OFFICE_MIMES[extension] }) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RetryableError("Document conversion timed out")), 90000); }),
    ]);
  } catch { throw new RetryableError("Document conversion is temporarily unavailable"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
  if (result.format === "error" || typeof result.data !== "string") throw new Error("This Office document could not be read. Remove password protection or export a PDF copy.");
  return completeText(result.data);
}
