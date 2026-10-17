import type { D1Database } from "@cloudflare/workers-types";
import type { RunHistory } from "./repos";
import type { Env } from "../env";
import { logEvent } from "../log";

export interface HistoryFilter { view: "active" | "archive" | "all"; group: string; search: string; page: number }
export interface HistoryItem extends RunHistory { campaign_id: string; title: string; history_group: string; archived_at: number | null }
export interface HistoryPage { items: HistoryItem[]; groups: string[]; total: number; filter: HistoryFilter }
export const HISTORY_PAGE_SIZE = 50;

export async function listHistory(db: D1Database, userId: string, filter: HistoryFilter): Promise<HistoryPage> {
  const clauses = ["c.user_id = ?"];
  const params: (string | number)[] = [userId];
  if (filter.view !== "all") clauses.push(`r.archived_at IS ${filter.view === "active" ? "NULL" : "NOT NULL"}`);
  if (filter.group) { clauses.push("r.history_group = ?"); params.push(filter.group); }
  if (filter.search) {
    clauses.push("(instr(lower(c.idea),lower(?)) > 0 OR EXISTS (SELECT 1 FROM articles a WHERE a.run_id=r.id AND instr(lower(a.title),lower(?)) > 0))");
    params.push(filter.search, filter.search);
  }
  const where = clauses.join(" AND ");
  const [rows, count, groups] = await Promise.all([
    db.prepare(`SELECT r.id,r.campaign_id,r.state,r.created_at,r.history_group,r.archived_at,c.idea,
      COALESCE((SELECT a.title FROM articles a WHERE a.run_id=r.id ORDER BY a.id LIMIT 1),c.idea) AS title
      FROM runs r JOIN campaigns c ON c.id=r.campaign_id WHERE ${where}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).bind(...params, HISTORY_PAGE_SIZE, (filter.page - 1) * HISTORY_PAGE_SIZE).all<HistoryItem>(),
    db.prepare(`SELECT COUNT(*) AS n FROM runs r JOIN campaigns c ON c.id=r.campaign_id WHERE ${where}`).bind(...params).first<{n: number}>(),
    db.prepare("SELECT DISTINCT r.history_group FROM runs r JOIN campaigns c ON c.id=r.campaign_id WHERE c.user_id=? AND r.history_group<>'' ORDER BY r.history_group COLLATE NOCASE").bind(userId).all<{history_group: string}>(),
  ]);
  const lastPage = Math.max(1, Math.ceil((count?.n ?? 0) / HISTORY_PAGE_SIZE));
  if (filter.page > lastPage) return listHistory(db, userId, { ...filter, page: lastPage });
  return { items: rows.results, groups: groups.results.map((g) => g.history_group), total: count?.n ?? 0, filter };
}

export class HistoryError extends Error {
  constructor(message: string, public status: 400 | 404 | 409) { super(message); }
}

/** Scope every action to the owner; reject mixed selections before making changes. */
export async function changeHistory(env: Env, userId: string, ids: string[], action: "archive" | "restore" | "group" | "delete", group = ""): Promise<number> {
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > HISTORY_PAGE_SIZE || unique.some((id) => !/^run_[a-zA-Z0-9-]+$/.test(id))) throw new HistoryError("Select between 1 and 50 history items.", 400);
  const slots = unique.map(() => "?").join(",");
  const base = `SELECT r.id FROM runs r JOIN campaigns c ON c.id=r.campaign_id WHERE c.user_id=? AND r.id IN (${slots})`;
  const owned = await env.DB.prepare(base).bind(userId, ...unique).all<{id: string}>();
  if (owned.results.length !== unique.length) throw new HistoryError("One or more history items are no longer available.", 404);
  if (action !== "delete") {
    const value = action === "archive" ? Date.now() : action === "restore" ? null : group.trim().replace(/\s+/g, " ");
    if (typeof value === "string" && value.length > 80) throw new HistoryError("Use a group name of up to 80 characters.", 400);
    const result = await env.DB.prepare(`UPDATE runs SET ${action === "group" ? "history_group" : "archived_at"}=? WHERE id IN (${base})`).bind(value, userId, ...unique).run();
    return result.meta.changes;
  }
  const now = Date.now();
  const candidates = `${base} AND r.state IN ('ready','failed','needs_input','awaiting_topic_selection')
    AND (r.lease_owner IS NULL OR r.lease_until<=?)
    AND NOT EXISTS (SELECT 1 FROM article_image_jobs j JOIN articles a ON a.id=j.article_id WHERE a.run_id=r.id AND j.state IN ('queued','working'))`;
  const args = [userId, ...unique, now];
  // Each statement re-evaluates the entire selection inside the same transaction.
  // The CTE uses one set of bindings and prevents partial deletion after a race.
  const eligible = `WITH selected AS (${candidates}) SELECT id FROM selected WHERE (SELECT COUNT(*) FROM selected)=${unique.length}`;
  const deletable = await env.DB.prepare(eligible).bind(...args).all<{id: string}>();
  if (deletable.results.length !== unique.length) throw new HistoryError("Some selected items are still generating. Archive them now, or wait before deleting.", 409);
  const campaignRows = await env.DB.prepare(`SELECT DISTINCT campaign_id FROM runs WHERE id IN (${base})`).bind(userId, ...unique).all<{campaign_id: string}>();
  const campaignIds = campaignRows.results.map((c) => c.campaign_id);
  const orphan = `SELECT c.id FROM campaigns c WHERE c.user_id=? AND c.id IN (${campaignIds.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.campaign_id=c.id)`;
  const orphanArgs = [userId, ...campaignIds];
  // Atomic D1 deletion plus durable cleanup intents. Five minutes allows in-flight
  // export writes to finish before their now-private orphaned assets are removed.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO asset_cleanup(prefix,due_at) SELECT 'articles/'||id||'/',? FROM articles WHERE run_id IN (${eligible})`).bind(now + 300_000, ...args),
    env.DB.prepare(`INSERT OR IGNORE INTO asset_cleanup(prefix,due_at) SELECT 'runs/'||id||'/',? FROM runs WHERE id IN (${eligible})`).bind(now + 300_000, ...args),
    env.DB.prepare(`DELETE FROM article_progress WHERE run_id IN (${eligible})`).bind(...args),
    env.DB.prepare(`DELETE FROM articles WHERE run_id IN (${eligible})`).bind(...args),
    env.DB.prepare(`DELETE FROM topics WHERE run_id IN (${eligible})`).bind(...args),
    env.DB.prepare(`DELETE FROM runs WHERE id IN (${eligible})`).bind(...args),
    env.DB.prepare(`INSERT OR IGNORE INTO asset_cleanup(prefix,due_at) SELECT 'grounding/'||id||'/',? FROM campaigns WHERE id IN (${orphan})`).bind(now + 300_000, ...orphanArgs),
    env.DB.prepare(`DELETE FROM grounding_docs WHERE campaign_id IN (${orphan})`).bind(...orphanArgs),
    env.DB.prepare(`DELETE FROM campaigns WHERE id IN (${orphan})`).bind(...orphanArgs),
  ]);
  const changed = result[5]!.meta.changes;
  if (changed !== unique.length) throw new HistoryError("Your selection changed or started generating. Nothing in this selection was deleted. Refresh and try again.", 409);
  return changed;
}

/** Bounded, replay-safe cleanup; provider failures leave durable work for the next cron. */
export async function cleanDeletedAssets(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT prefix,cursor,attempts,sweep FROM asset_cleanup WHERE due_at<=? ORDER BY due_at,prefix LIMIT 10").bind(Date.now()).all<{prefix: string; cursor: string; attempts: number; sweep: number}>();
  for (const row of rows.results) {
    try {
      const page = await env.ASSETS.list({ prefix: row.prefix, cursor: row.cursor || undefined, limit: 100 });
      if (page.objects.length) await env.ASSETS.delete(page.objects.map((o) => o.key));
      if (page.truncated) await env.DB.prepare("UPDATE asset_cleanup SET cursor=?,attempts=0 WHERE prefix=? AND cursor=? AND sweep=?").bind(page.cursor, row.prefix, row.cursor, row.sweep).run();
      else if (!row.sweep) await env.DB.prepare("UPDATE asset_cleanup SET cursor='',attempts=0,sweep=1,due_at=? WHERE prefix=? AND cursor=? AND sweep=0")
        .bind(Date.now() + 15 * 60_000, row.prefix, row.cursor).run();
      else await env.DB.prepare("DELETE FROM asset_cleanup WHERE prefix=? AND cursor=? AND sweep=?").bind(row.prefix, row.cursor, row.sweep).run();
    } catch {
      const attempts = row.attempts + 1;
      await env.DB.prepare("UPDATE asset_cleanup SET due_at=?,attempts=?,cursor=? WHERE prefix=? AND cursor=? AND sweep=?")
        .bind(Date.now() + Math.min(3600, 60 * 2 ** Math.min(attempts, 6)) * 1000, attempts, attempts % 3 === 0 ? "" : row.cursor, row.prefix, row.cursor, row.sweep).run();
      logEvent("history.cleanup_retry", { prefix: row.prefix, attempts });
    }
  }
}
