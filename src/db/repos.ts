/** Typed repositories, one per table. Thin CRUD over D1. */
import type { D1Database } from "@cloudflare/workers-types";
import { all, exec, execChanges, newId, now, one } from "./client";

// Explicit allowlists of columns a dynamic UPDATE may touch (never derive column
// identifiers from arbitrary object keys).
const CAMPAIGN_UPDATABLE = new Set([
  "idea", "grounding_refs", "voice_profile", "max_words", "image_brief",
  "persona", "tone", "temperature", "signature", "image_style",
  "reference_links", "cta", "cta_action", "cta_target",
  "include_ideas", "exclude_ideas", "bias_level", "output_format", "article_type",
]);
const ARTICLE_UPDATABLE = new Set([
  "title", "body_html", "excerpt", "slug", "meta_desc", "key_phrases", "output_body",
  "svg_r2_key", "png_r2_key", "bundle_r2_key",
]);

function updateAllowed(
  db: D1Database,
  table: string,
  id: string,
  fields: Record<string, unknown>,
  allow: Set<string>,
): Promise<void> {
  const keys = Object.keys(fields).filter((k) => allow.has(k));
  if (keys.length === 0) return Promise.resolve();
  const set = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) => fields[k]);
  return exec(db, `UPDATE ${table} SET ${set} WHERE id = ?`, ...vals, id);
}

export type RunState =
  | "needs_input"
  | "drafting_topics"
  | "awaiting_topic_selection"
  | "writing"
  | "styling"
  | "asset_gen"
  | "ready"
  | "failed";

export interface User {
  id: string;
  email: string;
  created_at: number;
}

export interface Campaign {
  id: string;
  user_id: string;
  idea: string;
  grounding_refs: string; // json array of {kind,source}
  voice_profile: string;
  max_words: number;
  image_brief: string;
  persona: string;
  tone: string;
  temperature: number;
  signature: string;
  image_style: string;
  reference_links: string; // json array of {url,label}
  cta: string; // CTA preset value
  cta_action: string; // '', 'website', 'email', 'whatsapp', 'call'
  cta_target: string; // raw URL / email / phone the owner entered
  include_ideas: string; // optional: ideas/points the article must cover
  exclude_ideas: string; // optional: things the article must not mention
  bias_level: number; // 1..5; 1 = neutral/honest, 5 = strongly promotional
  output_format: string; // 'html' | 'social' | 'plain' | 'markdown' | 'word'
  article_type: string; // 'article' | 'comparison' | 'listicle' | 'howto' | 'news' | 'blog' | 'opinion' | 'review'
  created_at: number;
}

export interface GroundingDoc {
  id: string;
  campaign_id: string;
  kind: "url" | "upload";
  source: string;
  r2_key: string;
  hash: string;
}

export interface Run {
  id: string;
  campaign_id: string;
  state: RunState;
  error: string | null;
  created_at: number;
  lease_owner: string | null;
  lease_until: number;
  regen_count: number;
  output_format: string; // per-run output target, set at the selection gate
}

export interface Topic {
  id: string;
  campaign_id: string;
  run_id: string;
  title: string;
  angle: string;
  summary: string;
  primary_kw: string;
  volume: number | null;
  difficulty: number | null;
  selected: number;
}

export interface RunHistory {
  id: string;
  state: RunState;
  created_at: number;
  idea: string;
  history_group?: string;
}

export interface Article {
  id: string;
  run_id: string;
  title: string;
  body_html: string;
  excerpt: string;
  slug: string;
  meta_desc: string;
  key_phrases: string; // json array
  svg_r2_key: string | null;
  png_r2_key: string | null;
  bundle_r2_key: string | null;
  similar_to: string; // title of the most similar prior article ('' if none)
  similar_score: number; // 0..1 blended similarity to that article
  output_format: string; // format this article was rendered for (default 'html')
  output_body: string; // rendered body in that format ('' for html/word: use body_html)
}

// ---- users ----------------------------------------------------------------

export const users = {
  async upsertByEmail(db: D1Database, email: string): Promise<User> {
    // Race-free: ON CONFLICT means concurrent first-sight requests can't collide
    // on the unique email constraint. Then read the canonical row.
    await exec(
      db,
      "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
      newId("usr"),
      email,
      now(),
    );
    const user = await one<User>(db, "SELECT * FROM users WHERE email = ?", email);
    if (!user) throw new Error(`user upsert failed for ${email}`);
    return user;
  },
  get(db: D1Database, id: string) {
    return one<User>(db, "SELECT * FROM users WHERE id = ?", id);
  },
};

// ---- campaigns ------------------------------------------------------------

export interface GroundingRef {
  kind: "url" | "upload";
  source: string;
}

export const campaigns = {
  async create(
    db: D1Database,
    input: {
      user_id: string;
      idea: string;
      grounding_refs: GroundingRef[];
      voice_profile?: string;
      max_words?: number;
      image_brief?: string;
      persona?: string;
      tone?: string;
      temperature?: number;
      signature?: string;
      image_style?: string;
      reference_links?: string;
      cta?: string;
      cta_action?: string;
      cta_target?: string;
      include_ideas?: string;
      exclude_ideas?: string;
      bias_level?: number;
      output_format?: string;
      article_type?: string;
    },
  ): Promise<Campaign> {
    const c: Campaign = {
      id: newId("cmp"),
      user_id: input.user_id,
      idea: input.idea,
      grounding_refs: JSON.stringify(input.grounding_refs),
      voice_profile: input.voice_profile ?? "ms-en",
      max_words: input.max_words ?? 650,
      image_brief: input.image_brief ?? "",
      persona: input.persona ?? "",
      tone: input.tone ?? "",
      temperature: input.temperature ?? 0.6,
      signature: input.signature ?? "",
      image_style: input.image_style ?? "",
      reference_links: input.reference_links ?? "[]",
      cta: input.cta ?? "",
      cta_action: input.cta_action ?? "",
      cta_target: input.cta_target ?? "",
      include_ideas: input.include_ideas ?? "",
      exclude_ideas: input.exclude_ideas ?? "",
      bias_level: input.bias_level ?? 3,
      output_format: input.output_format ?? "html",
      article_type: input.article_type ?? "article",
      created_at: now(),
    };
    await exec(
      db,
      `INSERT INTO campaigns (id, user_id, idea, grounding_refs, voice_profile, max_words, image_brief, persona, tone, temperature, signature, image_style, reference_links, cta, cta_action, cta_target, include_ideas, exclude_ideas, bias_level, output_format, article_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id,
      c.user_id,
      c.idea,
      c.grounding_refs,
      c.voice_profile,
      c.max_words,
      c.image_brief,
      c.persona,
      c.tone,
      c.temperature,
      c.signature,
      c.image_style,
      c.reference_links,
      c.cta,
      c.cta_action,
      c.cta_target,
      c.include_ideas,
      c.exclude_ideas,
      c.bias_level,
      c.output_format,
      c.article_type,
      c.created_at,
    );
    return c;
  },
  get(db: D1Database, id: string) {
    return one<Campaign>(db, "SELECT * FROM campaigns WHERE id = ?", id);
  },
  listForUser(db: D1Database, userId: string) {
    return all<Campaign>(
      db,
      "SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC",
      userId,
    );
  },
  update(db: D1Database, id: string, fields: Partial<Campaign>) {
    return updateAllowed(db, "campaigns", id, fields, CAMPAIGN_UPDATABLE);
  },
  /** Cascade-delete a campaign and everything under it, atomically. */
  async remove(db: D1Database, id: string) {
    await db.batch([
      db
        .prepare(
          "DELETE FROM articles WHERE run_id IN (SELECT id FROM runs WHERE campaign_id = ?)",
        )
        .bind(id),
      db.prepare("DELETE FROM topics WHERE campaign_id = ?").bind(id),
      db.prepare("DELETE FROM grounding_docs WHERE campaign_id = ?").bind(id),
      db.prepare("DELETE FROM runs WHERE campaign_id = ?").bind(id),
      db.prepare("DELETE FROM campaigns WHERE id = ?").bind(id),
    ]);
  },
  refs(c: Campaign): GroundingRef[] {
    try {
      const parsed = JSON.parse(c.grounding_refs);
      if (!Array.isArray(parsed)) return [];
      // Validate each entry's shape rather than trusting the stored JSON.
      return parsed.filter(
        (r): r is GroundingRef =>
          r &&
          (r.kind === "url" || r.kind === "upload") &&
          typeof r.source === "string",
      );
    } catch {
      return [];
    }
  },
};

// ---- grounding_docs -------------------------------------------------------

export const groundingDocs = {
  async create(
    db: D1Database,
    input: Omit<GroundingDoc, "id">,
  ): Promise<GroundingDoc> {
    const d: GroundingDoc = { id: newId("gnd"), ...input };
    // ON CONFLICT DO NOTHING: under at-least-once queue delivery two concurrent
    // ingests of the same (campaign_id, hash) can both reach here; the unique
    // index makes the loser a no-op. The caller re-reads the canonical row.
    await exec(
      db,
      `INSERT INTO grounding_docs (id, campaign_id, kind, source, r2_key, hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, hash) DO NOTHING`,
      d.id,
      d.campaign_id,
      d.kind,
      d.source,
      d.r2_key,
      d.hash,
    );
    return d;
  },
  listForCampaign(db: D1Database, campaignId: string) {
    // Deterministic order (insertion order via rowid) so the [S1..Sn] source ids
    // derived from this list stay stable across queue retries / resumes.
    return all<GroundingDoc>(
      db,
      "SELECT * FROM grounding_docs WHERE campaign_id = ? ORDER BY rowid ASC",
      campaignId,
    );
  },
  /** Existing doc with this content hash, if any (dedup on replay/edit). */
  byHash(db: D1Database, campaignId: string, hash: string) {
    return one<GroundingDoc>(
      db,
      "SELECT * FROM grounding_docs WHERE campaign_id = ? AND hash = ?",
      campaignId,
      hash,
    );
  },
};

// ---- runs -----------------------------------------------------------------

export const runs = {
  async create(db: D1Database, campaignId: string): Promise<Run> {
    const r: Run = {
      id: newId("run"),
      campaign_id: campaignId,
      state: "drafting_topics",
      error: null,
      created_at: now(),
      lease_owner: null,
      lease_until: 0,
      regen_count: 0,
      output_format: "html",
    };
    await exec(
      db,
      "INSERT INTO runs (id, campaign_id, state, created_at) VALUES (?, ?, ?, ?)",
      r.id,
      r.campaign_id,
      r.state,
      r.created_at,
    );
    return r;
  },
  get(db: D1Database, id: string) {
    return one<Run>(db, "SELECT * FROM runs WHERE id = ?", id);
  },
  /** Owner-scoped fetch: null unless the run belongs to the user (tenant isolation). */
  getForUser(db: D1Database, runId: string, userId: string) {
    return one<Run>(
      db,
      `SELECT r.* FROM runs r JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.id = ? AND c.user_id = ?`,
      runId,
      userId,
    );
  },
  /** Compare-and-set state transition. Returns true iff a row moved from->to. */
  async transition(
    db: D1Database,
    id: string,
    from: RunState,
    to: RunState,
  ): Promise<boolean> {
    const changed = await execChanges(
      db,
      "UPDATE runs SET state = ?, error = NULL WHERE id = ? AND state = ?",
      to,
      id,
      from,
    );
    return changed > 0;
  },
  /**
   * The selection gate: move awaiting_topic_selection -> writing AND record the
   * chosen output format in the SAME compare-and-set, so the format is bound to
   * the run that actually won the write. Concurrent submits or overlapping runs
   * cannot clobber each other's format (H-01). Returns true iff this call won.
   */
  async claimWriteWithFormat(
    db: D1Database,
    id: string,
    outputFormat: string,
  ): Promise<boolean> {
    const changed = await execChanges(
      db,
      `UPDATE runs SET state = 'writing', error = NULL, output_format = ?
       WHERE id = ? AND state = 'awaiting_topic_selection'`,
      outputFormat,
      id,
    );
    return changed > 0;
  },
  /** State and lease move together before the next delivery can claim work. */
  async handOff(db: D1Database, id: string, from: RunState, to: RunState, owner: string): Promise<boolean> {
    return (await execChanges(db, `UPDATE runs SET state=?,error=NULL,lease_owner=NULL,lease_until=0
      WHERE id=? AND state=? AND lease_owner=?`, to, id, from, owner)) > 0;
  },
  /**
   * Claim a TTL lease on a run for exclusive stage execution. Atomic: only one
   * of N concurrent (at-least-once) deliveries wins. The lease is claimable when
   * it is unheld or expired AND the run is in `expectedState`. Returns the new
   * owner token on success, or null if another worker holds a live lease.
   * A failed attempt should releaseStage() so a retry can reclaim before TTL.
   */
  async claimStage(
    db: D1Database,
    id: string,
    expectedState: RunState,
    ttlMs: number,
  ): Promise<string | null> {
    const owner = crypto.randomUUID();
    const nowMs = Date.now();
    const changed = await execChanges(
      db,
      `UPDATE runs SET lease_owner = ?, lease_until = ?
       WHERE id = ? AND state = ? AND (lease_until < ? OR lease_owner IS NULL)`,
      owner,
      nowMs + ttlMs,
      id,
      expectedState,
      nowMs,
    );
    return changed > 0 ? owner : null;
  },
  /** Release a lease we own so a retry can reclaim immediately (best-effort). */
  releaseStage(db: D1Database, id: string, owner: string) {
    return exec(
      db,
      "UPDATE runs SET lease_owner = NULL, lease_until = 0 WHERE id = ? AND lease_owner = ?",
      id,
      owner,
    );
  },
  /** Atomically bump the regeneration counter and return the new value. */
  async bumpRegen(db: D1Database, id: string): Promise<number> {
    await exec(db, "UPDATE runs SET regen_count = regen_count + 1 WHERE id = ?", id);
    const row = await one<{ regen_count: number }>(
      db,
      "SELECT regen_count FROM runs WHERE id = ?",
      id,
    );
    return row?.regen_count ?? 0;
  },
  /** Count non-terminal runs a user currently owns (for active-run quota). */
  /**
   * Non-terminal runs for a user, split by who they are waiting on: `generating`
   * = the pipeline is working; `awaiting` = parked at the angle picker, waiting
   * for the USER. Both hold a slot against the active-run cap, but the error
   * message must tell the user the truth: waiting never frees an awaiting run.
   */
  async activeCountsForUser(
    db: D1Database,
    userId: string,
  ): Promise<{ generating: number; awaiting: number }> {
    const row = await one<{ generating: number; awaiting: number }>(
      db,
      `SELECT
         SUM(CASE WHEN r.state = 'awaiting_topic_selection' THEN 1 ELSE 0 END) AS awaiting,
         SUM(CASE WHEN r.state NOT IN ('ready','failed','needs_input','awaiting_topic_selection') THEN 1 ELSE 0 END) AS generating
       FROM runs r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.user_id = ?`,
      userId,
    );
    return { generating: row?.generating ?? 0, awaiting: row?.awaiting ?? 0 };
  },
  listForCampaign(db: D1Database, campaignId: string) {
    return all<Run>(db, "SELECT * FROM runs WHERE campaign_id = ?", campaignId);
  },
  /** Run history for a user, newest first, with the campaign idea for labels. */
  listForUser(db: D1Database, userId: string) {
    return all<RunHistory>(
      db,
      `SELECT r.id, r.state, r.created_at, r.history_group, c.idea
       FROM runs r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.user_id = ? AND r.archived_at IS NULL
       ORDER BY r.created_at DESC
       LIMIT 50`,
      userId,
    );
  },
  setState(db: D1Database, id: string, state: RunState) {
    return exec(db, "UPDATE runs SET state = ?, error = NULL WHERE id = ?", state, id);
  },
  fail(db: D1Database, id: string, error: string) {
    return exec(
      db,
      "UPDATE runs SET state = 'failed', error = ? WHERE id = ?",
      error,
      id,
    );
  },
};

// ---- topics ---------------------------------------------------------------

export const topics = {
  async createMany(
    db: D1Database,
    campaignId: string,
    runId: string,
    items: {
      title: string;
      angle: string;
      summary?: string;
      primary_kw: string;
      volume?: number | null;
      difficulty?: number | null;
    }[],
  ): Promise<Topic[]> {
    const rows: Topic[] = items.map((t) => ({
      id: newId("top"),
      campaign_id: campaignId,
      run_id: runId,
      title: t.title,
      angle: t.angle,
      summary: t.summary ?? "",
      primary_kw: t.primary_kw,
      volume: t.volume ?? null,
      difficulty: t.difficulty ?? null,
      selected: 0,
    }));
    if (rows.length > 0) {
      const insert = db.prepare(
        `INSERT INTO topics (id, campaign_id, run_id, title, angle, summary, primary_kw, volume, difficulty, selected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      );
      await db.batch(
        rows.map((r) =>
          insert.bind(
            r.id, r.campaign_id, r.run_id, r.title, r.angle, r.summary,
            r.primary_kw, r.volume, r.difficulty,
          ),
        ),
      );
    }
    return rows;
  },
  /**
   * Atomically swap in a fresh topic set: delete the run's old topics and insert
   * the new ones in one batch, so a failed generation never leaves the user with
   * no suggestions (the old set survives until the replacement is ready).
   */
  async replaceForRun(
    db: D1Database,
    campaignId: string,
    runId: string,
    items: {
      title: string;
      angle: string;
      summary?: string;
      primary_kw: string;
      volume?: number | null;
      difficulty?: number | null;
    }[],
  ): Promise<Topic[]> {
    const rows: Topic[] = items.map((t) => ({
      id: newId("top"),
      campaign_id: campaignId,
      run_id: runId,
      title: t.title,
      angle: t.angle,
      summary: t.summary ?? "",
      primary_kw: t.primary_kw,
      volume: t.volume ?? null,
      difficulty: t.difficulty ?? null,
      selected: 0,
    }));
    const insert = db.prepare(
      `INSERT INTO topics (id, campaign_id, run_id, title, angle, summary, primary_kw, volume, difficulty, selected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    await db.batch([
      db.prepare("DELETE FROM topics WHERE run_id = ?").bind(runId),
      ...rows.map((r) =>
        insert.bind(
          r.id, r.campaign_id, r.run_id, r.title, r.angle, r.summary,
          r.primary_kw, r.volume, r.difficulty,
        ),
      ),
    ]);
    return rows;
  },
  listForRun(db: D1Database, runId: string) {
    return all<Topic>(db, "SELECT * FROM topics WHERE run_id = ?", runId);
  },
  deleteForRun(db: D1Database, runId: string) {
    return exec(db, "DELETE FROM topics WHERE run_id = ?", runId);
  },
  get(db: D1Database, id: string) {
    return one<Topic>(db, "SELECT * FROM topics WHERE id = ?", id);
  },
  async select(db: D1Database, runId: string, topicIds: string[]) {
    // Atomic clear-then-set so selection can never be observed half-applied.
    const stmts = [
      db.prepare("UPDATE topics SET selected = 0 WHERE run_id = ?").bind(runId),
      ...topicIds.map((id) =>
        db
          .prepare("UPDATE topics SET selected = 1 WHERE id = ? AND run_id = ?")
          .bind(id, runId),
      ),
    ];
    await db.batch(stmts);
  },
  selectedForRun(db: D1Database, runId: string) {
    return all<Topic>(
      db,
      "SELECT * FROM topics WHERE run_id = ? AND selected = 1",
      runId,
    );
  },
};

// ---- articles -------------------------------------------------------------

export type ArticleInsert = Omit<
  Article,
  "id" | "svg_r2_key" | "bundle_r2_key" | "similar_to" | "similar_score" | "output_format" | "output_body"
> & { similar_to?: string; similar_score?: number; output_format?: string; output_body?: string };

function toArticleRow(input: ArticleInsert): Article {
  return {
    id: newId("art"),
    svg_r2_key: null,
    bundle_r2_key: null,
    ...input,
    similar_to: input.similar_to ?? "",
    similar_score: input.similar_score ?? 0,
    output_format: input.output_format ?? "html",
    output_body: input.output_body ?? "",
  };
}

export const articles = {
  async create(db: D1Database, input: ArticleInsert): Promise<Article> {
    const a = toArticleRow(input);
    await exec(
      db,
      `INSERT INTO articles (id, run_id, title, body_html, excerpt, slug, meta_desc, key_phrases, png_r2_key, similar_to, similar_score, output_format, output_body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.run_id,
      a.title,
      a.body_html,
      a.excerpt,
      a.slug,
      a.meta_desc,
      a.key_phrases,
      a.png_r2_key,
      a.similar_to,
      a.similar_score,
      a.output_format,
      a.output_body,
    );
    return a;
  },
  /**
   * Atomically replace a run's articles: delete the old set and insert the new
   * one in a single batch, so a failed retry never deletes already-completed
   * articles before their replacements are ready.
   */
  async replaceForRun(
    db: D1Database,
    runId: string,
    inputs: ArticleInsert[],
  ): Promise<Article[]> {
    const rows: Article[] = inputs.map(toArticleRow);
    const insert = db.prepare(
      `INSERT INTO articles (id, run_id, title, body_html, excerpt, slug, meta_desc, key_phrases, png_r2_key, similar_to, similar_score, output_format, output_body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await db.batch([
      db.prepare("DELETE FROM articles WHERE run_id = ?").bind(runId),
      ...rows.map((a) =>
        insert.bind(
          a.id, a.run_id, a.title, a.body_html, a.excerpt, a.slug,
          a.meta_desc, a.key_phrases, a.png_r2_key, a.similar_to, a.similar_score,
          a.output_format, a.output_body,
        ),
      ),
    ]);
    return rows;
  },
  /**
   * The user's prior articles (title + body only, newest first, bounded) for
   * near-duplicate comparison. Excludes the run currently being generated.
   */
  priorForUser(db: D1Database, userId: string, exceptRunId: string, limit = 50) {
    return all<{ title: string; body_html: string }>(
      db,
      `SELECT a.title, a.body_html FROM articles a
       JOIN runs r ON r.id = a.run_id
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.user_id = ? AND a.run_id != ?
       ORDER BY r.created_at DESC
       LIMIT ?`,
      userId,
      exceptRunId,
      limit,
    );
  },
  get(db: D1Database, id: string) {
    return one<Article>(db, "SELECT * FROM articles WHERE id = ?", id);
  },
  async attachImageIfUnchanged(db: D1Database, snapshot: Article, pngKey: string): Promise<boolean> {
    return (await execChanges(db, `UPDATE articles SET png_r2_key = ?, bundle_r2_key = NULL
      WHERE id = ? AND title = ? AND body_html = ?`, pngKey, snapshot.id, snapshot.title, snapshot.body_html)) > 0;
  },
  /** Owner-scoped fetch: null unless the article belongs to the user. */
  getForUser(db: D1Database, articleId: string, userId: string) {
    return one<Article>(
      db,
      `SELECT a.* FROM articles a
       JOIN runs r ON r.id = a.run_id
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE a.id = ? AND c.user_id = ?`,
      articleId,
      userId,
    );
  },
  listForRun(db: D1Database, runId: string) {
    return all<Article>(db, "SELECT * FROM articles WHERE run_id = ?", runId);
  },
  deleteForRun(db: D1Database, runId: string) {
    return exec(db, "DELETE FROM articles WHERE run_id = ?", runId);
  },
  update(db: D1Database, id: string, fields: Partial<Article>) {
    return updateAllowed(db, "articles", id, fields, ARTICLE_UPDATABLE);
  },
};

// ---- article_progress (write-stage checkpoint) ----------------------------

export interface ArticleProgress {
  run_id: string;
  topic_id: string;
  plan_json: string;
  sections_json: string;
  updated_at: number;
}

export const articleProgress = {
  load(db: D1Database, runId: string, topicId: string) {
    return one<ArticleProgress>(
      db,
      "SELECT * FROM article_progress WHERE run_id = ? AND topic_id = ?",
      runId,
      topicId,
    );
  },
  save(
    db: D1Database,
    runId: string,
    topicId: string,
    planJson: string,
    sectionsJson: string,
  ) {
    return exec(
      db,
      `INSERT INTO article_progress (run_id, topic_id, plan_json, sections_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, topic_id) DO UPDATE SET
         plan_json = excluded.plan_json,
         sections_json = excluded.sections_json,
         updated_at = excluded.updated_at`,
      runId,
      topicId,
      planJson,
      sectionsJson,
      now(),
    );
  },
  clearForRun(db: D1Database, runId: string) {
    return exec(db, "DELETE FROM article_progress WHERE run_id = ?", runId);
  },
};
