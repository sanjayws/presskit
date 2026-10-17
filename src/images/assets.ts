import type { Article } from "../db/repos";

export function imageJobPrefix(articleId: string, jobId: string): string {
  return `articles/${articleId}/image-jobs/${jobId}`;
}

/** Keep a replacement image paired with its own brief, even if a later job fails. */
export function articleImageBriefKey(article: Pick<Article, "id" | "png_r2_key">): string {
  return article.png_r2_key?.includes("/image-jobs/")
    ? article.png_r2_key.replace(/featured\.png$/, "image-brief.json")
    : `articles/${article.id}/image-brief.json`;
}
