/** One durable, exclusively claimed image-only job per article. */
import type { D1Database } from "@cloudflare/workers-types";
import { all, exec, execChanges, newId, one } from "./client";

export type ImageJobMode = "retry" | "new";
export interface ImageJob {
  article_id: string;
  id: string;
  mode: ImageJobMode;
  state: "queued" | "working" | "ready" | "failed";
  error: string | null;
  source_brief_key: string | null;
  requested_at: number;
  window_started_at: number;
  request_count: number;
  lease_owner: string | null;
  lease_until: number;
}

export const MAX_IMAGE_REQUESTS_PER_HOUR = 5;
const WINDOW_MS = 3_600_000;

export const imageJobs = {
  get(db: D1Database, articleId: string) {
    return one<ImageJob>(db, "SELECT * FROM article_image_jobs WHERE article_id = ?", articleId);
  },
  listForRun(db: D1Database, runId: string) {
    return all<ImageJob>(db, `SELECT j.* FROM article_image_jobs j JOIN articles a ON a.id = j.article_id WHERE a.run_id = ?`, runId);
  },
  /** Atomic request/cost gate: concurrent clicks cannot enqueue two paid jobs. */
  async request(db: D1Database, articleId: string, mode: ImageJobMode, sourceBriefKey: string | null): Promise<ImageJob | null> {
    const id = newId("img");
    const now = Date.now();
    const changed = await execChanges(db, `
      INSERT INTO article_image_jobs (article_id, id, mode, state, source_brief_key, requested_at, window_started_at, request_count)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, 1)
      ON CONFLICT(article_id) DO UPDATE SET
        id = excluded.id, mode = excluded.mode, state = 'queued', error = NULL,
        source_brief_key = excluded.source_brief_key, requested_at = excluded.requested_at,
        request_count = CASE WHEN window_started_at <= ? THEN 1 ELSE request_count + 1 END,
        window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
        lease_owner = NULL, lease_until = 0
      WHERE state IN ('ready', 'failed') AND (window_started_at <= ? OR request_count < ?)`,
    articleId, id, mode, sourceBriefKey, now, now, now - WINDOW_MS, now - WINDOW_MS, now - WINDOW_MS, MAX_IMAGE_REQUESTS_PER_HOUR);
    return changed ? this.get(db, articleId) : null;
  },
  async claim(db: D1Database, articleId: string, id: string): Promise<string | null> {
    const owner = crypto.randomUUID();
    const now = Date.now();
    const changed = await execChanges(db, `UPDATE article_image_jobs SET state = 'working', lease_owner = ?, lease_until = ?
      WHERE article_id = ? AND id = ? AND state IN ('queued', 'working') AND (lease_owner IS NULL OR lease_until <= ?)`,
    owner, now + 300_000, articleId, id, now);
    return changed ? owner : null;
  },
  release(db: D1Database, articleId: string, id: string, owner: string) {
    return exec(db, `UPDATE article_image_jobs SET lease_owner = NULL, lease_until = 0
      WHERE article_id = ? AND id = ? AND lease_owner = ?`, articleId, id, owner);
  },
  finish(db: D1Database, articleId: string, id: string, state: "ready" | "failed", error: string | null = null) {
    return exec(db, `UPDATE article_image_jobs SET state = ?, error = ?, lease_owner = NULL, lease_until = 0
      WHERE article_id = ? AND id = ?`, state, error, articleId, id);
  },
  /** Persist safe initial-generation failures without counting a manual retry. */
  initialFailure(db: D1Database, articleId: string, error: string) {
    const now = Date.now();
    return exec(db, `INSERT INTO article_image_jobs (article_id, id, mode, state, error, requested_at, window_started_at, request_count)
      VALUES (?, ?, 'retry', 'failed', ?, ?, ?, 0) ON CONFLICT(article_id) DO NOTHING`,
    articleId, newId("img"), error, now, now);
  },
};
