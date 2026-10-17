declare module "word-extractor" {
  import type { Buffer } from "node:buffer";
  export default class WordExtractor {
    extract(buffer: Buffer): Promise<{ getBody(): string; getFootnotes(): string; getEndnotes(): string; getHeaders(): string; getFooters(): string; getTextboxes(): string }>;
  }
}
declare module "*ppt.cjs" {
  import type { Buffer } from "node:buffer";
  const PPT: { readBuffer(buffer: Buffer): unknown; utils: { to_text(presentation: unknown): string[] } };
  export default PPT;
}
