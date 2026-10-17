/** Small helpers over D1. Keeps repos free of boilerplate. */
import type { D1Database } from "@cloudflare/workers-types";

/** Crypto-random id. Prefixed for readability in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function now(): number {
  return Date.now();
}

/** Run a statement, return nothing. */
export async function exec(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<void> {
  await db
    .prepare(sql)
    .bind(...params)
    .run();
}

/** Run a statement, return the number of rows changed. */
export async function execChanges(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<number> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .run();
  return res.meta?.changes ?? 0;
}

/** First row or null. */
export async function one<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<T>();
  return row ?? null;
}

/** All rows. */
export async function all<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return res.results ?? [];
}
