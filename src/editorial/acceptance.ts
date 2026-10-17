/** Bind an explicit editorial exception to the precise saved draft and report. */
import type { Article } from "../db/repos";
import type { EditorialCheckpoint } from "./review";
export async function reviewFingerprint(article: Article, checkpoint: EditorialCheckpoint): Promise<string> {
  const { id, title, body_html, excerpt, meta_desc, slug, key_phrases, output_format, output_body } = article;
  const bytes = new TextEncoder().encode(JSON.stringify({ id, title, body_html, excerpt, meta_desc, slug, key_phrases, output_format, output_body,
    core: checkpoint.core, report: checkpoint.report, input: checkpoint.input }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function acceptanceSnapshot(items: { article: Article; checkpoint: EditorialCheckpoint | null }[]): Promise<string> {
  if (!items.length || items.some(({ checkpoint: c }) => !c?.report || !["passed", "needs_attention", "accepted"].includes(c.state))
    || !items.some(({ checkpoint: c }) => c?.state === "needs_attention" || c?.state === "accepted")) return "";
  return (await Promise.all([...items].sort((a, b) => a.article.id.localeCompare(b.article.id)).map(({ article, checkpoint }) => reviewFingerprint(article, checkpoint!)))).join(".");
}
