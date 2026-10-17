import { passwordConfigured, passwordLoginPage, loginAllowed, checkPassword } from "./auth/password";
/**
 * Presskit — Worker entry. Hono app + in-app Google-OAuth-gated
 * routes + the pipeline queue consumer. Export only: no route publishes anywhere.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env, PipelineMessage } from "./env";
import {
  buildAuthUrl,
  createSessionCookie,
  exchangeCode,
  googleConfigured,
  randomState,
  readSession,
  userFromEmail,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "./auth/google";
import {
  campaigns,
  runs,
  topics,
  articles,
  groundingDocs,
  type User,
} from "./db/repos";
import { validateGroundingUrl } from "./grounding/ingest";
import { enqueueBundle, enqueueWrite, resumeTopics, startRun } from "./pipeline/run";
import { handleQueue } from "./pipeline/queue";
import { buildBundle } from "./bundle/export";
import { sanitizeHtml } from "./content/sanitize";
import { canonicalizeSlug, sanitizeKeyPhrases } from "./content/validate";
import { parseReferenceLinksText } from "./content/enrich";
import { CTAS, CTA_ACTIONS, PERSONAS, TONES, IMAGE_STYLES, isOutputFormat, isArticleType, type OutputFormat } from "./style/engine";
import { renderOutput, isRichFormat } from "./content/render";
import { imageJobs } from "./db/image-jobs";
import { articleImageBriefKey, imageJobPrefix } from "./images/assets";
import { loadEditorial, editorialKey, channelIssues, type EditorialCheckpoint } from "./editorial/review";
import { loadSourceReport, sourceReportKey, sourceFailureGuidance } from "./grounding/report";
import { imageStatus, imageVersionKey, listImageVersions } from "./images/history";
import { saveSourceUpload, sourceUploads, savedSourceDocuments } from "./grounding/uploads";
import { MAX_SOURCE_BYTES, SOURCE_EXTENSIONS } from "./grounding/documents";
import { getRecovery, recoverStalledRuns, resumeSavedRun } from "./pipeline/recovery";
import { loadReadiness, readinessKey } from "./grounding/readiness";
import { recheckSavedDraft } from "./pipeline/editorial";
import { listHistory, changeHistory, cleanDeletedAssets, HistoryError, type HistoryFilter } from "./db/history";

/** Keep only a value that exists in an option list; otherwise "". */
function allowedValue(list: { value: string }[], v: string): string {
  return list.some((o) => o.value === v) ? v : "";
}
import { stripDashes } from "./style/lint";
import {
  dashboard,
  helpScreen,
  editCampaign,
  imageGallery,
  resultScreen,
  runProgress,
  topicSelect,
  type Nav,
} from "./ui/pages";
import { historyScreen } from "./ui/history";

type Vars = { user: User; nonce: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("*", bodyLimit({ maxSize: 11_000_000, onError: (c) => c.text("This submission is too large. Use a document of up to 10 MB.", 413) }));

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
  ].join("; ");
}

// Global error handler: never leak internals; log a safe diagnostic.
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", path: c.req.path, msg: err.message }));
  return c.text("Something went wrong. Please try again.", 500);
});

// --- health (unauthenticated) ----------------------------------------------
app.get("/healthz", (c) => c.json({ ok: true }));

// --- Google sign-in ---------------------------------------------------------
app.get("/auth/login", (c) => {
  if (passwordConfigured(c.env)) {
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(passwordLoginPage(googleConfigured(c.env)));
  }
  if (!googleConfigured(c.env)) return c.text("Configure password or Google login, SESSION_SECRET and APP_BASE_URL.", 503);
  const state = randomState();
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return c.redirect(buildAuthUrl(c.env, state));
});
app.post("/auth/password", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!passwordConfigured(c.env)) return c.text("Password login is not enabled.", 503);
  if (c.req.header("origin") !== new URL(c.req.url).origin) return c.text("Sign in from this site's login page.", 403);
  const raw = await c.req.text();
  if (raw.length > 4096) return c.text("Login submission too large.", 413);
  const form = new URLSearchParams(raw);
  const email = (form.get("email") || "").trim().toLowerCase(), password = form.get("password") || "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 256) return c.text("Invalid email or password.", 401);
  if (!await loginAllowed(c.env, email, c.req.header("cf-connecting-ip") || "unknown")) {
    c.header("Retry-After", "900"); return c.text("Too many sign-in attempts. Wait 15 minutes and try again.", 429);
  }
  const account = await checkPassword(c.env, email, password);
  if (!account) return c.text("Invalid email or password.", 401);
  setCookie(c, SESSION_COOKIE, await createSessionCookie(c.env, email, account.version), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 604800 });
  return c.redirect("/");
});

app.get("/auth/google", (c) => {
  if (!googleConfigured(c.env)) {
    return c.text(
      "Google login is not configured yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, and APP_BASE_URL.",
      503,
    );
  }
  const state = randomState();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.redirect(buildAuthUrl(c.env, state));
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  if (!code || !state || !expected || state !== expected) {
    return c.text("Invalid OAuth state. Please try signing in again.", 400);
  }
  try {
    const { email } = await exchangeCode(c.env, code);
    const value = await createSessionCookie(c.env, email);
    setCookie(c, SESSION_COOKIE, value, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 604800,
    });
    return c.redirect("/");
  } catch (e) {
    // Log the detail server-side; return a generic message to the browser.
    console.error(`auth callback failed: ${e instanceof Error ? e.message : String(e)}`);
    return c.text("Sign-in failed. Please try again.", 403);
  }
});

app.get("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/auth/login");
});

// --- auth gate for everything else -----------------------------------------
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (path === "/healthz" || path.startsWith("/auth/")) return next();

  let email: string | null = null;
  if (c.env.DEV_AUTH_EMAIL) {
    email = c.env.DEV_AUTH_EMAIL.toLowerCase();
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) email = await readSession(c.env, token);
  }

  if (!email) {
    // Browser navigations go to the login flow; other calls get a plain 401.
    if (c.req.method === "GET" && !c.req.header("accept")?.includes("application/json")) return c.redirect("/auth/login");
    return c.text("Unauthorized", 401);
  }

  const user: User = await userFromEmail(c.env, email);
  c.set("user", user);
  const origin = c.req.header("origin");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && origin && origin !== new URL(c.req.url).origin) {
    return c.text("This request did not originate from this workspace.", 403);
  }

  // Per-request CSP nonce for the single inline <script> in each page.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  c.set("nonce", nonce);

  await next();

  // Security headers on authenticated responses.
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", contentSecurityPolicy(nonce));
});

// Build the sidebar nav (identity + run history) for an authed request.
async function buildNav(
  c: { env: Env; get: (k: "nonce") => string | undefined },
  user: User,
): Promise<Nav> {
  return {
    email: user.email,
    history: await runs.listForUser(c.env.DB, user.id),
    nonce: c.get("nonce") ?? "",
  };
}

// --- dashboard --------------------------------------------------------------
app.get("/", async (c) => {
  const nav = await buildNav(c, c.get("user"));
  return c.html(dashboard(nav));
});

app.get("/help", async (c) => c.html(helpScreen(await buildNav(c, c.get("user")))));

function historyFilter(query: Record<string, string>): HistoryFilter {
  return { view: query.view === "archive" || query.view === "all" ? query.view : "active",
    group: (query.group || "").slice(0, 80), search: (query.search || "").slice(0, 200),
    page: Math.max(1, Math.min(100000, Number.parseInt(query.page || "1", 10) || 1)) };
}
app.get("/history", async (c) => {
  const user = c.get("user");
  const [nav, page] = await Promise.all([buildNav(c, user), listHistory(c.env.DB, user.id, historyFilter(c.req.query()))]);
  const action = c.req.query("done");
  const past = { archive: "archived", restore: "restored", group: "moved", delete: "deleted" }[action || ""];
  const count = Math.max(0, Math.min(50, Number.parseInt(c.req.query("count") || "0", 10) || 0));
  return c.html(historyScreen(nav, page, past ? `${count} item${count === 1 ? "" : "s"} ${past}.${action === "delete" ? " Saved files are removed in the background." : ""}` : undefined));
});
app.post("/history", async (c) => {
  const form = await c.req.formData();
  const action = fstr(form, "action");
  if (action !== "archive" && action !== "restore" && action !== "group" && action !== "delete") return c.text("Choose a history action.", 400);
  const ids = form.getAll("run_id").filter((v): v is string => typeof v === "string");
  const user = c.get("user");
  const filter = historyFilter(Object.fromEntries(["view", "group", "search", "page"].map((key) => [key, fstr(form, `filter_${key}`)])));
  try {
    // Server-rendered confirmation also works with JavaScript disabled. Recheck
    // ownership and generation state again on the confirmed mutation.
    if (action === "delete" && form.get("confirmed") !== "delete") {
      const page = await listHistory(c.env.DB, user.id, filter);
      const selected = page.items.filter((item) => ids.includes(item.id));
      if (!ids.length || selected.length !== new Set(ids).size) return c.text("Select available items on this page.", 400);
      return c.html(historyScreen(await buildNav(c, user), page, undefined, selected));
    }
    const count = await changeHistory(c.env, user.id, ids, action, fstr(form, "target_group"));
    const query = new URLSearchParams(Object.entries({ ...filter, done: action, count }).map(([key, value]) => [key, String(value)]));
    return c.redirect(`/history?${query.toString()}`, 303);
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    const page = await listHistory(c.env.DB, user.id, filter);
    return c.html(historyScreen(await buildNav(c, user), page, error.message), error.status);
  }
});

interface CampaignFields {
  idea: string;
  urls: string[];
  upload: File | null;
  voice_profile: string;
  max_words: number;
  image_brief: string;
  persona: string;
  tone: string;
  temperature: number;
  signature: string;
  image_style: string;
  reference_links: string; // json array of {url,label}
  cta: string;
  cta_action: string;
  cta_target: string;
  include_ideas: string;
  exclude_ideas: string;
  bias_level: number;
  article_type: string;
  output_format: OutputFormat;
}

// Read a form field as a string, ignoring any non-string (File) value.
function fstr(form: FormData, key: string, fallback = ""): string {
  const v = form.get(key);
  return typeof v === "string" ? v : fallback;
}

function parseCampaignFields(form: FormData): CampaignFields {
  const upload = form.get("upload");
  return {
    idea: fstr(form, "idea").trim(),
    urls: fstr(form, "urls")
      .split(/\r?\n/)
      .map((s) => s.trim())
    .filter(Boolean),
    upload: upload != null && typeof upload !== "string" && upload.size > 0 ? upload : null,
    voice_profile: fstr(form, "voice_profile", "ms-en"),
    max_words: Math.max(200, Math.min(2000, Number(form.get("max_words")) || 2000)),
    image_brief: fstr(form, "image_brief").trim().slice(0, 1000),
    persona: allowedValue(PERSONAS, fstr(form, "persona").slice(0, 40)),
    tone: allowedValue(TONES, fstr(form, "tone").slice(0, 40)),
    temperature: Math.max(0, Math.min(2, Number(form.get("temperature")) || 0.6)),
    signature: fstr(form, "signature").trim().slice(0, 160),
    image_style: allowedValue(IMAGE_STYLES, fstr(form, "image_style").slice(0, 40)),
    reference_links: JSON.stringify(parseReferenceLinksText(fstr(form, "reference_links"))),
    cta: allowedValue(CTAS, fstr(form, "cta").slice(0, 40)),
    cta_action: allowedValue(CTA_ACTIONS, fstr(form, "cta_action").slice(0, 20)),
    cta_target: fstr(form, "cta_target").trim().slice(0, 400),
    include_ideas: fstr(form, "include_ideas").trim(),
    exclude_ideas: fstr(form, "exclude_ideas").trim(),
    bias_level: Math.max(1, Math.min(5, Math.round(Number(form.get("bias_level")) || 3))),
    article_type: isArticleType(fstr(form, "article_type"))
      ? fstr(form, "article_type")
      : "article",
    output_format: isOutputFormat(fstr(form, "output_format")) ? fstr(form, "output_format") as OutputFormat : "html",
  };
}

const MAX_UPLOAD_BYTES = MAX_SOURCE_BYTES;
const MAX_URLS = 10;
const MAX_ACTIVE_RUNS = 3;

/** Validate a campaign submission. Returns an HTTP error Response, or null if OK. */
async function validateSubmission(
  c: { env: Env; text: (t: string, s?: number) => Response },
  userId: string,
  f: CampaignFields,
  savedDocumentCount = 0,
): Promise<Response | null> {
  if (!f.idea) return c.text("idea required", 400);
  if (f.idea.length > 12000) return c.text("Keep the article brief to 12,000 characters or fewer.", 400);
  if (f.include_ideas.length > 6000 || f.exclude_ideas.length > 6000) return c.text("Keep each editorial direction field to 6,000 characters or fewer.", 400);
  if (f.upload && f.upload.size > MAX_UPLOAD_BYTES) {
    return c.text("Uploaded document is too large (max 10 MB).", 400);
  }
  if (f.upload && !SOURCE_EXTENSIONS.test(f.upload.name)) {
    return c.text("Upload a PDF, Word, Excel, PowerPoint, CSV or text document.", 400);
  }
  if (f.urls.length > MAX_URLS) {
    return c.text(`Too many grounding URLs (max ${MAX_URLS}).`, 400);
  }
  if (f.urls.length === 0 && !f.upload && !savedDocumentCount) {
    return c.text("Provide at least one source URL or a readable supporting document. Saved files marked unreadable cannot be used.", 400);
  }
  for (const u of f.urls) {
    try {
      validateGroundingUrl(u);
    } catch (e) {
      return c.text(`${e instanceof Error ? e.message : "invalid url"}`, 400);
    }
  }
  const act = await runs.activeCountsForUser(c.env.DB, userId);
  if (act.generating + act.awaiting >= MAX_ACTIVE_RUNS) {
    // Be truthful about WHO each run is waiting on: a run parked at the angle
    // picker waits for the user and never finishes on its own, so "wait for one
    // to finish" would be dead advice there.
    const parts: string[] = [];
    if (act.generating > 0) {
      parts.push(`${act.generating} still generating`);
    }
    if (act.awaiting > 0) {
      parts.push(
        `${act.awaiting} waiting for you to choose an angle`,
      );
    }
    const advice =
      act.awaiting > 0
        ? "Open a waiting run from the sidebar and pick a topic (or delete its campaign) to free a slot."
        : "Wait for a run to finish, then try again.";
    return c.text(
      `Active run limit reached (max ${MAX_ACTIVE_RUNS}): ${parts.join(" and ")}. ${advice}`,
      429,
    );
  }
  return null;
}

// --- create campaign + start a run -----------------------------------------
app.post("/campaigns", async (c) => {
  const user = c.get("user");
  const f = parseCampaignFields(await c.req.formData());
  const bad = await validateSubmission(c, user.id, f);
  if (bad) return bad;

  const campaign = await campaigns.create(c.env.DB, {
    user_id: user.id,
    idea: f.idea,
    grounding_refs: f.urls.map((u) => ({ kind: "url" as const, source: u })),
    voice_profile: f.voice_profile,
    max_words: f.max_words,
    image_brief: f.image_brief,
    persona: f.persona,
    tone: f.tone,
    temperature: f.temperature,
    signature: f.signature,
    image_style: f.image_style,
    reference_links: f.reference_links,
    cta: f.cta,
    cta_action: f.cta_action,
    cta_target: f.cta_target,
    include_ideas: f.include_ideas,
    exclude_ideas: f.exclude_ideas,
    bias_level: f.bias_level,
    article_type: f.article_type,
    output_format: f.output_format,
  });

  if (f.upload) {
    try { await saveSourceUpload(c.env, campaign.id, f.upload); }
    catch (error) {
      await campaigns.remove(c.env.DB, campaign.id);
      return c.text(`Supporting document: ${sourceFailureGuidance(error)}`, 400);
    }
  }

  const run = await runs.create(c.env.DB, campaign.id);
  await startRun(c.env, run.id);
  return c.redirect(`/runs/${run.id}`);
});

// --- edit campaign (pre-filled form) ---------------------------------------
app.get("/campaigns/:id/edit", async (c) => {
  const user = c.get("user");
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== user.id) return c.notFound();
  const nav = await buildNav(c, user);
  return c.html(editCampaign(nav, campaign, await savedSourceDocuments(c.env, campaign.id)));
});

// --- update campaign + regenerate (replaces current) -----------------------
app.post("/campaigns/:id", async (c) => {
  const user = c.get("user");
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== user.id) return c.notFound();

  const f = parseCampaignFields(await c.req.formData());
  const bad = await validateSubmission(c, user.id, f, (await savedSourceDocuments(c.env, campaign.id)).filter((doc) => doc.status === "loaded" || doc.status === "pending").length);
  if (bad) return bad;

  if (f.upload) {
    try { await saveSourceUpload(c.env, campaign.id, f.upload); }
    catch (error) {
      return c.text(`Supporting document: ${sourceFailureGuidance(error)}`, 400);
    }
  }

  await campaigns.update(c.env.DB, campaign.id, {
    idea: f.idea,
    grounding_refs: JSON.stringify(f.urls.map((u) => ({ kind: "url", source: u }))),
    voice_profile: f.voice_profile,
    max_words: f.max_words,
    image_brief: f.image_brief,
    persona: f.persona,
    tone: f.tone,
    temperature: f.temperature,
    signature: f.signature,
    image_style: f.image_style,
    reference_links: f.reference_links,
    cta: f.cta,
    cta_action: f.cta_action,
    cta_target: f.cta_target,
    include_ideas: f.include_ideas,
    exclude_ideas: f.exclude_ideas,
    bias_level: f.bias_level,
    article_type: f.article_type,
    output_format: f.output_format,
  });

  const run = await runs.create(c.env.DB, campaign.id);
  await startRun(c.env, run.id);
  return c.redirect(`/runs/${run.id}`);
});

// --- delete campaign (cascade + R2 cleanup) --------------------------------
app.post("/campaigns/:id/delete", async (c) => {
  const user = c.get("user");
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== user.id) return c.notFound();

  // Best-effort R2 cleanup: grounding docs + article assets, in parallel.
  try {
    const keys: string[] = [];
    const docs = await groundingDocs.listForCampaign(c.env.DB, campaign.id);
    for (const d of docs) keys.push(d.r2_key);
    for (const upload of await sourceUploads(c.env, campaign.id)) keys.push(upload.r2_key);
    const campaignRuns = await runs.listForCampaign(c.env.DB, campaign.id);
    for (const r of campaignRuns) {
      keys.push(sourceReportKey(r.id));
      keys.push(readinessKey(r.id));
      const arts = await articles.listForRun(c.env.DB, r.id);
      for (const a of arts) {
        if (a.png_r2_key) keys.push(a.png_r2_key);
        if (a.bundle_r2_key) keys.push(a.bundle_r2_key);
        keys.push(editorialKey(a.id), `articles/${a.id}/featured.png`, `articles/${a.id}/image-brief.json`);
        // Includes failed/superseded image-only jobs, not just the active PNG.
        let cursor: string | undefined;
        do {
          const assets = await c.env.ASSETS.list({ prefix: `articles/${a.id}/image-jobs/`, cursor });
          if (assets.objects.length) await c.env.ASSETS.delete(assets.objects.map((object) => object.key));
          cursor = assets.truncated ? assets.cursor : undefined;
        } while (cursor);
      }
    }
    if (keys.length) await c.env.ASSETS.delete(keys); // R2 supports bulk delete
  } catch (e) {
    console.error(`R2 cleanup failed for ${campaign.id}: ${String(e)}`);
  }

  await campaigns.remove(c.env.DB, campaign.id);
  return c.redirect("/");
});

// Lightweight polling avoids re-rendering the shell/history on every check.
// Owner scoping and no-store headers are the same as the full run view.
app.get("/runs/:id/status", async (c) => {
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!run) return c.notFound();
  const recovery = await getRecovery(c.env, run.id);
  const background = { ...(recovery?.retrying ? { retrying: true } : {}), ...(recovery ? { stage: recovery.stage } : {}) };
  if (run.state === "styling") {
    const list = await articles.listForRun(c.env.DB, run.id);
    const review = list[0] ? await loadEditorial(c.env, list[0].id) : null;
    if (review) return c.json({ state: run.state, ...background, editorial: { state: review.state, revision: review.revision } });
  }
  return c.json({ state: run.state, ...background });
});

app.post("/runs/:id/resume", async (c) => {
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!run) return c.notFound();
  if (run.state !== "failed" && run.state !== "needs_input") return c.redirect(`/runs/${run.id}`);
  if (run.state === "needs_input" && !(await loadSourceReport(c.env, run.id)).some((source) => source.status === "unavailable")) {
    return c.text("Use Edit brief to address the listed missing details, then check the updated brief.", 409);
  }
  for (const article of await articles.listForRun(c.env.DB, run.id)) {
    if ((await loadEditorial(c.env, article.id))?.state === "needs_attention") return c.text("Update the brief or sources to resolve the editorial findings.", 409);
  }
  const active = await runs.activeCountsForUser(c.env.DB, c.get("user").id);
  if (active.generating + active.awaiting >= MAX_ACTIVE_RUNS) return c.text("Finish a waiting run before resuming this one.", 429);
  if (!await resumeSavedRun(c.env, run.id)) return c.text("This older run has no recovery checkpoint. Edit the brief to create a new run.", 409);
  return c.redirect(`/runs/${run.id}`);
});

app.post("/runs/:id/recheck", async (c) => {
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!run) return c.notFound();
  if (run.state !== "failed") return c.redirect(`/runs/${run.id}`);
  const active = await runs.activeCountsForUser(c.env.DB, c.get("user").id);
  if (active.generating + active.awaiting >= MAX_ACTIVE_RUNS) return c.text("Finish a waiting run before rechecking this draft.", 429);
  if (!await recheckSavedDraft(c.env, run.id)) return c.text("This run has no completed review to recheck, or a recheck is already starting. Reopen the run to see its saved status.", 409);
  return c.redirect(`/runs/${run.id}`);
});

// --- run view: progress / topic select / result ----------------------------
app.get("/runs/:id", async (c) => {
  const user = c.get("user");
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), user.id);
  if (!run) return c.notFound();
  const nav = await buildNav(c, user);

  const sources = await loadSourceReport(c.env, run.id);
  const readiness = await loadReadiness(c.env, run.id);
  if (run.state === "awaiting_topic_selection") {
    const list = await topics.listForRun(c.env.DB, run.id);
    const campaign = await campaigns.get(c.env.DB, run.campaign_id);
    return c.html(topicSelect(nav, run, list, sources, campaign?.output_format, readiness));
  }
  if (run.state === "ready") {
    const list = await articles.listForRun(c.env.DB, run.id);
    const jobs = await imageJobs.listForRun(c.env.DB, run.id);
    const galleries = await Promise.all(list.map(async (article) => [article.id,
      await listImageVersions(c.env.ASSETS, article, jobs.find((job) => job.article_id === article.id)),
    ] as const));
    const reviews: Record<string, EditorialCheckpoint> = {};
    for (const article of list) {
      const review = await loadEditorial(c.env, article.id);
      if (review) reviews[article.id] = review;
    }
    return c.html(resultScreen(nav, run, list, jobs, Object.fromEntries(galleries), reviews, sources));
  }
  const reviews: { articleId: string; checkpoint: EditorialCheckpoint }[] = [];
  if (run.state === "failed" || run.state === "styling") {
    for (const article of await articles.listForRun(c.env.DB, run.id)) {
      const checkpoint = await loadEditorial(c.env, article.id);
      if (checkpoint) reviews.push({ articleId: article.id, checkpoint });
    }
  }
  return c.html(runProgress(nav, run, sources, reviews, readiness));
});

// Server-side cap on how many topics one run may write (cost control). The
// two-step UI is single-angle; enforce that server-side so a crafted request
// cannot trigger multiple expensive agentic writes.
const MAX_SELECTED_TOPICS = 1;

// --- topic selection --------------------------------------------------------
app.post("/runs/:id/select", async (c) => {
  const user = c.get("user");
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), user.id);
  if (!run) return c.notFound();
  // Only selectable while awaiting selection; blocks replay/double-submit.
  if (run.state !== "awaiting_topic_selection") {
    return c.redirect(`/runs/${run.id}`);
  }
  const form = await c.req.formData();
  const picked = form.getAll("topic").map(String).filter(Boolean).slice(0, MAX_SELECTED_TOPICS);
  if (picked.length === 0) return c.text("select an angle", 400);

  // The output-format gate: the target platform is chosen here, alongside the
  // angle. It is a PER-RUN choice, bound to the run in the same compare-and-set
  // that claims the write (H-01), so overlapping runs can't clobber it.
  const fmt = fstr(form, "output_format");
  const outputFormat: OutputFormat = isOutputFormat(fmt) ? fmt : "html";

  // Persist the selection, then claim the write + format via compare-and-set.
  // Only the request that wins the CAS enqueues, so concurrent submits can't
  // double-write or cross-contaminate the format.
  await topics.select(c.env.DB, run.id, picked);
  const claimed = await runs.claimWriteWithFormat(c.env.DB, run.id, outputFormat);
  if (claimed) await enqueueWrite(c.env, run.id);
  return c.redirect(`/runs/${run.id}`);
});

// Cost budget: how many times one run may regenerate its angle suggestions.
const MAX_REGENERATIONS = 5;

// --- regenerate topic suggestions (step 2: "3 new titles") ------------------
// Re-runs the grounded topic proposal in place: rewinds the run to drafting and
// re-enqueues the topics stage, which replaces the current 3 and returns to
// awaiting_topic_selection. No new run is created (no quota hit).
app.post("/runs/:id/regenerate", async (c) => {
  const user = c.get("user");
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), user.id);
  if (!run) return c.notFound();
  // Only from the selection screen; blocks replay and mid-write regeneration.
  if (run.state !== "awaiting_topic_selection") {
    return c.redirect(`/runs/${run.id}`);
  }
  // Regeneration budget: each one is another paid grounded-search call.
  if (run.regen_count >= MAX_REGENERATIONS) {
    return c.text(
      `Regeneration limit reached (${MAX_REGENERATIONS}). Pick one of the current angles.`,
      429,
    );
  }
  // Claim the rewind via CAS; only the winner bumps the counter and enqueues.
  const claimed = await runs.transition(
    c.env.DB,
    run.id,
    "awaiting_topic_selection",
    "drafting_topics",
  );
  if (claimed) {
    await runs.bumpRegen(c.env.DB, run.id);
    await resumeTopics(c.env, run.id);
  }
  return c.redirect(`/runs/${run.id}`);
});

// Derive a safe download filename from a (possibly untrusted) slug.
function safeFilename(slug: string, fallback: string): string {
  const clean = (slug || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || fallback;
}

// --- asset + bundle downloads ----------------------------------------------
app.get("/sources/:id/markdown", async (c) => {
  const doc = await c.env.DB.prepare(`SELECT d.source,d.r2_key FROM grounding_docs d
    JOIN campaigns p ON p.id=d.campaign_id WHERE d.id=? AND p.user_id=?`)
    .bind(c.req.param("id"), c.get("user").id).first<{ source: string; r2_key: string }>();
  if (!doc) return c.notFound();
  const object = await c.env.ASSETS.get(doc.r2_key);
  if (!object) return c.notFound();
  return new Response(object.body, { headers: { "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${safeFilename(doc.source, "source")}.md"`, "cache-control": "private, no-store" } });
});

async function serveR2(
  env: Env,
  key: string | null,
  contentType: string,
  filename: string,
): Promise<Response> {
  if (!key) return new Response("Not found", { status: 404 });
  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  // Prefer the stored content type (the image model may return png or jpeg).
  const ct = obj.httpMetadata?.contentType || contentType;
  return new Response(obj.body, {
    headers: {
      "content-type": ct,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

app.get("/articles/:id/featured.png", async (c) => {
  const a = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!a) return c.notFound();
  return serveR2(c.env, a.png_r2_key, "image/png", `${safeFilename(a.slug, "featured")}.png`);
});

// The evidence and instructions that produced the visual, visible only to its owner.
app.get("/articles/:id/image-brief", async (c) => {
  const a = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!a) return c.notFound();
  return serveR2(c.env, articleImageBriefKey(a), "application/json", `${safeFilename(a.slug, "article")}-creative-brief.json`);
});

// Image-only actions: never rewind the run or discard the article/current image.
app.post("/articles/:id/image", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!article) return c.notFound();
  const run = await runs.get(c.env.DB, article.run_id);
  if (run?.state !== "ready") return c.json({ error: "Wait for this article to finish before requesting its visual." }, 409);
  let mode: unknown;
  try { mode = (await c.req.json<{ mode?: unknown }>()).mode; } catch { return c.json({ error: "Invalid image request." }, 400); }
  if (mode !== "retry" && mode !== "new") return c.json({ error: "Choose Retry or Generate New." }, 400);
  if (!c.env.OPENAI_API_KEY) return c.json({ error: "Image generation is not configured. Ask your administrator to set OPENAI_API_KEY." }, 503);
  const previous = await imageJobs.get(c.env.DB, article.id);
  if (mode === "retry" && article.png_r2_key && previous?.state !== "failed") {
    return c.json({ error: "This visual is already available. Use Generate New for a replacement." }, 409);
  }
  const sourceBriefKey = mode === "retry"
    ? previous?.state === "failed" ? `${imageJobPrefix(article.id, previous.id)}/image-brief.json` : articleImageBriefKey(article)
    : null;
  const job = await imageJobs.request(c.env.DB, article.id, mode, sourceBriefKey);
  if (!job) {
    const active = await imageJobs.get(c.env.DB, article.id);
    if (active?.state === "queued" || active?.state === "working") return c.json({ error: "A visual is already being generated. Please wait.", jobId: active.id }, 409);
    c.header("Retry-After", "3600");
    return c.json({ error: "Image request limit reached: five requests per article per hour. Try again later." }, 429);
  }
  try {
    await c.env.PIPELINE.send({ runId: article.run_id, stage: "image_refresh", articleId: article.id, imageJobId: job.id });
  } catch {
    await imageJobs.finish(c.env.DB, article.id, job.id, "failed", "The image request could not be queued. Retry in a moment.");
    return c.json({ error: "The image request could not be queued. Retry in a moment." }, 503);
  }
  return c.json({ ok: true, jobId: job.id, state: job.state }, 202);
});

app.get("/articles/:id/image-status", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!article) return c.notFound();
  const job = await imageJobs.get(c.env.DB, article.id);
  return c.json(imageStatus(article, job));
});

// Refresh just the gallery; the article editor and its unsaved changes stay intact.
app.get("/articles/:id/images", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!article) return c.notFound();
  const job = await imageJobs.get(c.env.DB, article.id);
  const versions = await listImageVersions(c.env.ASSETS, article, job);
  return c.json({ ...imageStatus(article, job), html: imageGallery(article, versions), count: versions.length });
});

app.get("/articles/:id/images/:version/:asset", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!article) return c.notFound();
  const version = c.req.param("version");
  const key = imageVersionKey(article.id, version);
  const asset = c.req.param("asset");
  if (!key || (asset !== "featured.png" && asset !== "image-brief")) return c.notFound();
  const filename = `${safeFilename(article.slug, "featured")}-${version}`;
  return asset === "featured.png"
    ? serveR2(c.env, key, "image/png", `${filename}.png`)
    : serveR2(c.env, key.replace(/featured\.png$/, "image-brief.json"), "application/json", `${filename}-creative-brief.json`);
});

app.get("/articles/:id/bundle.zip", async (c) => {
  const a = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!a) return c.notFound();
  const filename = `${safeFilename(a.slug, "article")}.zip`;

  // Stream the precomputed bundle from R2 when available; otherwise build once.
  if (a.bundle_r2_key) {
    const obj = await c.env.ASSETS.get(a.bundle_r2_key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    }
  }
  const zip = await buildBundle(c.env, a);
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});

function parseKeyPhrases(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// Download the article rendered in its chosen output format (.html/.doc/.md/.txt).
// Text formats serve the stored output_body; rich formats render from body_html.
app.get("/articles/:id/output", async (c) => {
  const a = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!a) return c.notFound();
  const format: OutputFormat = isOutputFormat(a.output_format) ? a.output_format : "html";
  const rendered =
    !isRichFormat(format) && a.output_body
      ? { body: a.output_body, ext: format === "markdown" ? "md" : "txt", mime: format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8" }
      : renderOutput(a.body_html, format, { keyPhrases: parseKeyPhrases(a.key_phrases), title: a.title, excerpt: a.excerpt, maxWords: Number.MAX_SAFE_INTEGER });
  const filename = `${safeFilename(a.slug, "article")}.${rendered.ext}`;
  return new Response(rendered.body, {
    headers: {
      "content-type": rendered.mime,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});

// --- inline article edit (WYSIWYG save) ------------------------------------
// Accepts the edited article back from the result screen. Everything is
// re-sanitized and house-styled server-side: the client HTML is never trusted.
const MAX_EDIT_BYTES = 400_000;

function plainText(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  return v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

app.post("/articles/:id", async (c) => {
  const user = c.get("user");
  const a = await articles.getForUser(c.env.DB, c.req.param("id"), user.id);
  if (!a) return c.notFound();

  // Reject oversized bodies before buffering when the length is declared.
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_EDIT_BYTES) {
    return c.json({ error: "Article too large." }, 413);
  }
  const raw = await c.req.text();
  // Cap by byte length (not JS chars) for unknown/chunked bodies.
  if (new TextEncoder().encode(raw).length > MAX_EDIT_BYTES) {
    return c.json({ error: "Article too large." }, 413);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return c.json({ error: "Invalid request." }, 400);
  } catch {
    return c.json({ error: "Invalid request." }, 400);
  }

  // Body: re-run the exact same allowlist sanitizer + dash strip as generation.
  const bodyIn = typeof payload.body_html === "string" ? payload.body_html : a.body_html;
  const body_html = stripDashes(await sanitizeHtml(bodyIn));
  const title = stripDashes(plainText(payload.title, a.title)).slice(0, 200).trim();
  const meta_desc = stripDashes(plainText(payload.meta_desc, a.meta_desc)).slice(0, 160).trim();
  const excerpt = stripDashes(plainText(payload.excerpt, a.excerpt)).slice(0, 400).trim();
  const slug = canonicalizeSlug(plainText(payload.slug, a.slug), title);
  const keyPhraseList = sanitizeKeyPhrases(
    typeof payload.key_phrases === "string" ? payload.key_phrases.split(",") : [],
  );
  const key_phrases = JSON.stringify(keyPhraseList);
  const format = isOutputFormat(a.output_format) ? a.output_format : "html";
  const output_body = isRichFormat(format) ? "" : renderOutput(body_html, format, { title, excerpt, keyPhrases: keyPhraseList, maxWords: Number.MAX_SAFE_INTEGER }).body;
  const warnings = channelIssues({ title, body_html, meta_desc, excerpt, slug, key_phrases: keyPhraseList }, format);

  await articles.update(c.env.DB, a.id, {
    title,
    body_html,
    meta_desc,
    excerpt,
    slug,
    key_phrases,
    output_body,
  });

  // Rebuild the download bundle off the HTTP path (replay-safe queue job), so
  // the save returns immediately and heavy zip work never blocks the request.
  await enqueueBundle(c.env, a.run_id, a.id);

  // Return the canonical saved content so the editor can reconcile (sanitized
  // HTML, canonicalized slug, stripped dashes) rather than trust its local copy.
  return c.json({
    ok: true,
    bundle: "rebuilding",
    warnings,
    article: { title, body_html, meta_desc, excerpt, slug, key_phrases: keyPhraseList },
  });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await Promise.all([recoverStalledRuns(env), cleanDeletedAssets(env), env.DB.prepare("DELETE FROM login_attempts WHERE window_start<?").bind(Date.now() - 24 * 60 * 60_000).run()]);
  },
  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};
