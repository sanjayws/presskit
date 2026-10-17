import type { R2Bucket } from "@cloudflare/workers-types";
import type { Article } from "../db/repos";
import type { ImageJob } from "../db/image-jobs";
import { imageJobPrefix } from "./assets";

export interface ImageVersion {
  id: string;
  createdAt: string | null;
}

/** Version IDs resolve only inside the authenticated article's asset directory. */
export function imageVersionKey(articleId: string, version: string): string | null {
  if (version === "original") return `articles/${articleId}/featured.png`;
  return /^img_[a-f0-9]{32}$/.test(version) ? `${imageJobPrefix(articleId, version)}/featured.png` : null;
}

export function currentImageVersion(article: Pick<Article, "png_r2_key">): string | null {
  if (!article.png_r2_key) return null;
  return /\/image-jobs\/(img_[a-f0-9]{32})\/featured\.png$/.exec(article.png_r2_key)?.[1] ?? "original";
}

export function imageStatus(article: Article, job: ImageJob | null | undefined) {
  const version = currentImageVersion(article);
  const state = job?.state ?? "idle";
  return {
    jobId: job?.id ?? null, state, error: job?.error ?? null,
    hasImage: Boolean(version), version,
    revision: `${version ?? ""}:${job?.id ?? ""}:${state}`,
  };
}

/** Discover retained copies, including generations made before the gallery existed. */
export async function listImageVersions(bucket: R2Bucket, article: Article, job?: ImageJob | null): Promise<ImageVersion[]> {
  const prefix = `articles/${article.id}/`;
  const versions: ImageVersion[] = [];
  const current = currentImageVersion(article);
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      const path = object.key.slice(prefix.length);
      const id = path === "featured.png" ? "original" : /^image-jobs\/(img_[a-f0-9]{32})\/featured\.png$/.exec(path)?.[1];
      if (!id) continue;
      // A job may have written its PNG but not yet validated/attached it.
      if (id === job?.id && id !== current && (job.state === "queued" || job.state === "working")) continue;
      versions.push({ id, createdAt: object.uploaded.toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (current && !versions.some((version) => version.id === current)) versions.push({ id: current, createdAt: null });
  return versions.sort((a, b) => {
    if (a.id === "original") return -1;
    if (b.id === "original") return 1;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
  });
}
