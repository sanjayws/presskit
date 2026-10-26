import { articleSchemaStarter, seoDraftReview } from "./seo/review";
import { campaignImages, validateImageSelection, saveImageSelection, ImageUploadError, runImages, IMAGE_ID, imageExtension, uploadedChannelError, enhancedImageKey, enhancedImageUrl, uploadedImageUrl, EmbeddedImageLimitError } from "./images/uploads";
import { loadUploadedPlacements, uploadedPlacementKey } from "./images/uploaded-inline";
import { loadVisual, visualBody, reuseAutoImageReadings } from "./images/vision";
import { optionJobKey, optionResultKey, recoverOptionJobs, type OptionRequest } from "./editorial/auto-decide";
import { exportInlineHtml, inlineKey, loadInline } from "./images/inline";
import { acceptReadiness, readinessAcceptanceToken } from "./grounding/acceptance";
import { channelBudgetError } from "./content/channel-budget";
import { MAX_CHANNELS, submittedChannels } from "./style/channels";
import { acceptanceSnapshot } from "./editorial/acceptance";
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
  campaignForRun,
  captureBrief,
  runs,
  topics,
  articles,
  type User,
} from "./db/repos";
import { validateGroundingUrl, uploadText } from "./grounding/ingest";
import { enqueueBundle, enqueueWrite, resumeTopics, startRun } from "./pipeline/run";
import { handleQueue } from "./pipeline/queue";
import { buildBundle, BUNDLE_VERSION, bundleFingerprint } from "./bundle/export";
import { sanitizeHtml } from "./content/sanitize";
import { canonicalizeSlug, sanitizeKeyPhrases } from "./content/validate";
import { parseReferenceLinksText } from "./content/enrich";
import { CTAS, CTA_ACTIONS, PERSONAS, TONES, IMAGE_STYLES, isOutputFormat, isArticleType, type OutputFormat } from "./style/engine";
import { renderOutput, isRichFormat } from "./content/render";
import { imageJobs } from "./db/image-jobs";
import { articleImageBriefKey, imageJobPrefix } from "./images/assets";
import { loadEditorial, channelIssues, type EditorialCheckpoint } from "./editorial/review";
import { loadSourceReport, sourceFailureGuidance } from "./grounding/report";
import { imageStatus, imageVersionKey, listImageVersions } from "./images/history";
import { saveSourceUpload, savedSourceDocuments } from "./grounding/uploads";
import { MAX_SOURCE_BYTES, SOURCE_EXTENSIONS } from "./grounding/documents";
import { getRecovery, recoverStalledRuns, resumeSavedRun } from "./pipeline/recovery";
import { loadReadiness } from "./grounding/readiness";
import { acceptSavedDraft, recheckSavedDraft } from "./pipeline/editorial";
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
app.use("/auth/password", bodyLimit({ maxSize: 4096, onError: (c) => c.text("Login submission too large.", 413) }));
app.use("*", bodyLimit({ maxSize: 21_000_000, onError: (c) => c.text("This submission is too large. Documents allow 10 MB; images allow 3 MB each and 10 MB combined, up to 6 images.", 413) }));

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
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return c.text("Use the sign-in form to log in.", 415);
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
  c.header("Content-Security-Policy", c.res.headers.get("content-type")?.startsWith("image/svg+xml") ? "default-src 'none'; sandbox" : contentSecurityPolicy(nonce));
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
  inline_image_count: number;
  output_format: OutputFormat;
  output_formats: string[];
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
    voice_profile: fstr(form, "voice_profile", "ms-en").slice(0, 40),
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
    inline_image_count: Number(fstr(form, "inline_image_count", "0")),
    output_formats: submittedChannels(form),
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
  planning = false,
  imageCount = 0,
): Promise<Response | null> {
  if (!Number.isInteger(f.inline_image_count) || f.inline_image_count < 0 || f.inline_image_count > 3) return c.text("Choose 0–3 inline images per supported output.", 400);
  if (f.output_formats.length > MAX_CHANNELS || f.output_formats.some((format) => !isOutputFormat(format))) return c.text(`Choose up to ${MAX_CHANNELS} valid destinations.`, 400);
  const budgetError = channelBudgetError(f, f.output_formats);
  if (budgetError) return c.text(budgetError, 400);
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
  if (!planning && f.article_type !== "fiction" && f.urls.length === 0 && !f.upload && !savedDocumentCount && !imageCount) {
    return c.text("Provide at least one source URL or a readable supporting document. Saved files marked unreadable cannot be used.", 400);
  }
  for (const u of f.urls) {
    try {
      validateGroundingUrl(u);
    } catch (e) {
      return c.text(`${e instanceof Error ? e.message : "invalid url"}`, 400);
    }
  }
  if (planning) return null;
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

app.post("/brief/auto-decide", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const f = parseCampaignFields(form);
  const bad = await validateSubmission(c, user.id, f, 0, true);
  if (bad) return bad;
  const campaignId = fstr(form, "campaign_id");
  if (campaignId && (await campaigns.get(c.env.DB, campaignId))?.user_id !== user.id) return c.notFound();
  let images;
  try { images = await validateImageSelection(form, campaignId ? await campaignImages(c.env.DB, campaignId) : []); }
  catch (error) { if (error instanceof ImageUploadError) return c.text(error.message, 400); throw error; }
  const imageError = uploadedChannelError([...images.saved, ...images.added.map((item) => item.image)], f.output_formats);
  if (imageError) return c.text(imageError, 400);
  const bytes = f.upload ? new Uint8Array(await f.upload.arrayBuffer()) : null;
  if (f.upload && bytes) {
    if (/\.pdf$/i.test(f.upload.name) && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return c.text("This PDF has an invalid file header. Export a new copy.", 400);
    if (!/\.(pdf|docx?|xlsx?|pptx?)$/i.test(f.upload.name)) {
      try { uploadText(new TextDecoder().decode(bytes)); } catch (error) { return c.text(sourceFailureGuidance(error), 400); }
    }
  }
  const id = `opt_${crypto.randomUUID().replace(/-/g, "")}`;
  const inserted = await c.env.DB.prepare(`INSERT INTO brief_option_jobs(id,user_id,created_at)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM brief_option_jobs WHERE user_id=? AND state IN ('queued','working') AND created_at>?)<2
    AND (SELECT COUNT(*) FROM brief_option_jobs WHERE user_id=? AND created_at>?)<10`)
    .bind(id, user.id, Date.now(), user.id, Date.now() - 86400000, user.id, Date.now() - 3600000).run();
  if (!inserted.meta.changes) return c.text("Auto decide allows two background jobs at a time and ten requests per hour. Wait for a current job or select settings manually.", 429);
  // Only validated brief fields reach the model; ignore arbitrary multipart fields.
  const fields = Object.fromEntries(Object.entries(f).filter(([key, value]) => key !== "upload" && (typeof value === "string" || typeof value === "number")).map(([key, value]) => [key, String(value)]));
  fields.output_formats = JSON.stringify(f.output_formats);
  fields.uploaded_image_descriptions = JSON.stringify([...images.saved, ...images.added.map((item) => item.image)].map(({ description, role,tag,use_when }) => ({ description, role,tag,useWhen:use_when || "" })));
  const request: OptionRequest = { fields, urls: f.urls, images:images.saved.map((image)=>({...image})),text: "", read: 0, uploadDone: !bytes, warnings: [], ...(campaignId ? { campaignId } : {}) };
  try {
    for (const item of images.added) {
      const image={...item.image,r2_key:`brief-options/${id}/images/${item.image.id}`};
      await c.env.ASSETS.put(image.r2_key,item.data,{httpMetadata:{contentType:image.content_type}});
      request.images!.push(image);
    }
    if (bytes && f.upload) {
      const extension = f.upload.name.slice(f.upload.name.lastIndexOf("."));
      request.filename = f.upload.name.length > 240 ? f.upload.name.slice(0, 240 - extension.length) + extension : f.upload.name; request.fileKey = `brief-options/${id}/upload`;
      await c.env.ASSETS.put(request.fileKey, bytes);
    }
    await c.env.ASSETS.put(optionJobKey(id), JSON.stringify(request));
  } catch {
    await c.env.DB.prepare("UPDATE brief_option_jobs SET state='failed',error='Could not save the configuration request. Try again.' WHERE id=?").bind(id).run();
    return c.text("Could not save the configuration request. Your brief is kept; try again.", 503);
  }
  try { await c.env.PIPELINE.send({ runId: id, stage: "brief_options" }); } catch { /* watchdog recovers */ }
  return c.json({ id }, 202);
});

app.get("/brief/auto-decide/:id", async (c) => {
  const job = await c.env.DB.prepare("SELECT id,state,error FROM brief_option_jobs WHERE id=? AND user_id=? AND created_at>?")
    .bind(c.req.param("id"), c.get("user").id, Date.now() - 86400000).first<{ id: string; state: string; error: string | null }>();
  if (!job) return c.notFound();
  const result = job.state === "ready" ? await c.env.ASSETS.get(optionResultKey(job.id)) : null;
  return c.json({ state: job.state, error: job.error, ...(result && result.size < 20000 ? await result.json<Record<string, unknown>>() : {}) });
});

// --- create campaign + start a run -----------------------------------------
app.post("/campaigns", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const f = parseCampaignFields(form);
  let images;
  try { images = await validateImageSelection(form); }
  catch (error) { if (error instanceof ImageUploadError) return c.text(error.message, 400); throw error; }
  const imageError = uploadedChannelError([...images.saved, ...images.added.map((item) => item.image)], f.output_formats);
  if (imageError) return c.text(imageError, 400);
  const bad = await validateSubmission(c, user.id, f, 0, false, images.saved.length + images.added.length);
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
    inline_image_count: f.inline_image_count,
    generation_version: 2,
    output_format: f.output_format,
    output_formats: JSON.stringify(f.output_formats),
  });

  if (f.upload) {
    try { await saveSourceUpload(c.env, campaign.id, f.upload); }
    catch (error) {
      await campaigns.remove(c.env.DB, campaign.id);
      return c.text(`Supporting document: ${sourceFailureGuidance(error)}`, 400);
    }
  }

  try { await saveImageSelection(c.env, campaign.id, images); }
  catch {
    await campaigns.remove(c.env.DB, campaign.id, [`grounding/${campaign.id}/`]);
    return c.text("Could not save your images. Your files are still selected in this form; try submitting again.", 503);
  }
  await reuseAutoImageReadings(c.env,user.id,fstr(form,"image_reading_job"),images.added.map((item)=>item.image)).catch(()=>undefined);

  const run = await runs.create(c.env.DB, campaign.id,true);
  await startRun(c.env, run.id);
  return c.redirect(`/runs/${run.id}`);
});

// --- edit campaign (pre-filled form) ---------------------------------------
app.get("/campaigns/:id/edit", async (c) => {
  const user = c.get("user");
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== user.id) return c.notFound();
  const nav = await buildNav(c, user);
  return c.html(editCampaign(nav, campaign, await savedSourceDocuments(c.env, campaign.id), await campaignImages(c.env.DB, campaign.id)));
});

app.get("/campaigns/:id/images/:imageId", async (c) => {
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== c.get("user").id) return c.notFound();
  const image = (await campaignImages(c.env.DB, campaign.id)).find((item) => item.id === c.req.param("imageId"));
  if (!image) return c.notFound();
  return serveR2(c.env, image.r2_key, image.content_type, `image.${imageExtension(image.content_type)}`);
});

// --- update campaign + regenerate (replaces current) -----------------------
app.post("/campaigns/:id", async (c) => {
  const user = c.get("user");
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== user.id) return c.notFound();

  const form = await c.req.formData();
  const f = parseCampaignFields(form);
  let images;
  try { images = await validateImageSelection(form, await campaignImages(c.env.DB, campaign.id)); }
  catch (error) { if (error instanceof ImageUploadError) return c.text(error.message, 400); throw error; }
  const imageError = uploadedChannelError([...images.saved, ...images.added.map((item) => item.image)], f.output_formats);
  if (imageError) return c.text(imageError, 400);
  const bad = await validateSubmission(c, user.id, f, (await savedSourceDocuments(c.env, campaign.id)).filter((doc) => doc.status === "loaded" || doc.status === "pending").length, false, images.saved.length + images.added.length);
  if (bad) return bad;

  const snapshot=await captureBrief(c.env.DB,campaign);
  await runs.freezeForCampaign(c.env.DB,campaign);

  if (f.upload) {
    try { snapshot.uploadIds.push(await saveSourceUpload(c.env, campaign.id, f.upload)); }
    catch (error) {
      return c.text(`Supporting document: ${sourceFailureGuidance(error)}`, 400);
    }
  }

  try { await saveImageSelection(c.env, campaign.id, images); }
  catch { return c.text("Could not save your images. Your brief is kept; try submitting again.", 503); }
  await reuseAutoImageReadings(c.env,user.id,fstr(form,"image_reading_job"),images.added.map((item)=>item.image)).catch(()=>undefined);

  const updates = {
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
    inline_image_count: f.inline_image_count,
    generation_version: 2,
    output_format: f.output_format,
    output_formats: JSON.stringify(f.output_formats),
  };
  await campaigns.update(c.env.DB, campaign.id, updates);
  snapshot.campaign={...campaign,...updates};

  const run = await runs.create(c.env.DB, campaign.id,snapshot,[...images.saved,...images.added.map((item)=>item.image)]);
  await startRun(c.env, run.id);
  return c.redirect(`/runs/${run.id}`);
});

// --- delete campaign (cascade + R2 cleanup) --------------------------------
app.post("/campaigns/:id/delete", async (c) => {
  const user = c.get("user");
  const campaign = await campaigns.get(c.env.DB, c.req.param("id"));
  if (!campaign || campaign.user_id !== user.id) return c.notFound();

  // Durable prefix cleanup includes inactive uploads retained for older runs.
  const prefixes = [`grounding/${campaign.id}/`];
  for (const run of await runs.listForCampaign(c.env.DB, campaign.id)) {
    prefixes.push(`runs/${run.id}/`);
    for (const article of await articles.listForRun(c.env.DB, run.id)) prefixes.push(`articles/${article.id}/`);
  }
  // Commit cleanup intents and deletion together. Storage failures retry in cron,
  // and a failed DB deletion cannot schedule deletion of a still-live brief's files.
  await campaigns.remove(c.env.DB, campaign.id, prefixes);
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

app.post("/runs/:id/accept-readiness", async (c) => {
  const user = c.get("user");
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), user.id);
  if (!run) return c.notFound();
  if (run.state !== "needs_input") return c.redirect(`/runs/${run.id}`);
  const form = await c.req.parseBody();
  if (form.accept_gaps !== "yes" || typeof form.snapshot !== "string") return c.text("Acknowledge the listed evidence gaps before continuing.", 400);
  const active = await runs.activeCountsForUser(c.env.DB, user.id);
  if (active.generating + active.awaiting >= MAX_ACTIVE_RUNS) return c.text("Finish a waiting run before continuing this brief.", 429);
  if (!await acceptReadiness(c.env, run.id, user.id, form.snapshot)) return c.text("The brief or findings changed, no readable source is available, or this run is already continuing. Reopen the run to review its current status.", 409);
  return c.redirect(`/runs/${run.id}`);
});

app.post("/runs/:id/accept-review", async (c) => {
  const user = c.get("user");
  const run = await runs.getForUser(c.env.DB, c.req.param("id"), user.id);
  if (!run) return c.notFound();
  if (run.state !== "failed") return c.redirect(`/runs/${run.id}`);
  const body = await c.req.parseBody();
  if (body.accept_exceptions !== "yes" || typeof body.snapshot !== "string") return c.text("Read the findings and confirm you accept the exceptions before continuing.", 400);
  const active = await runs.activeCountsForUser(c.env.DB, user.id);
  if (active.generating + active.awaiting >= MAX_ACTIVE_RUNS) return c.text("Finish a waiting run before continuing this draft.", 429);
  if (!await acceptSavedDraft(c.env, run.id, user.id, body.snapshot)) return c.text("The saved review changed or is already continuing. Reopen the run and review its current findings.", 409);
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
    const campaign = await campaignForRun(c.env.DB, run);
    return c.html(topicSelect(nav, run, list, sources, campaign?.output_format, readiness, campaign?.output_formats));
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
    return c.html(resultScreen(nav, run, list, jobs, Object.fromEntries(galleries), reviews, sources, readiness, Object.fromEntries(await Promise.all(list.map(async (article) => [article.id, await loadInline(c.env, article.id)]))),Object.fromEntries(await Promise.all(list.map(async (article) => [article.id,await loadUploadedPlacements(c.env,article.id)])))));
  }
  const savedReviews = run.state === "failed" || run.state === "styling"
    ? await Promise.all((await articles.listForRun(c.env.DB, run.id)).map(async (article) => ({ article, checkpoint: await loadEditorial(c.env, article.id) }))) : [];
  const reviews = savedReviews.flatMap(({ article, checkpoint }) => checkpoint ? [{ articleId: article.id, article, checkpoint }] : []);
  const snapshot = run.state === "failed" ? await acceptanceSnapshot(savedReviews) : "";
  const readinessCampaign = run.state === "needs_input" && readiness?.state === "needs_input" && sources.some((source) => source.status === "loaded")
    ? await campaignForRun(c.env.DB, run) : null;
  const readinessToken = readinessCampaign && readiness ? await readinessAcceptanceToken(readiness, readinessCampaign) : "";
  return c.html(runProgress(nav, run, sources, reviews, readiness, snapshot, readinessToken));
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
  const formats = submittedChannels(form);
  if (formats.length > MAX_CHANNELS || formats.some((format) => !isOutputFormat(format))) return c.text(`Choose up to ${MAX_CHANNELS} valid destinations.`, 400);
  const campaign = await campaignForRun(c.env.DB, run);
  if (!campaign) return c.notFound();
  const budgetError = channelBudgetError(campaign, formats);
  if (budgetError) return c.text(budgetError, 400);
  const imageError = uploadedChannelError(runImages(run), formats);
  if (imageError) return c.text(imageError, 400);
  const fmt = fstr(form, "output_format");
  const outputFormat: OutputFormat = isOutputFormat(fmt) ? fmt : "html";

  // Persist the selection, then claim the write + format via compare-and-set.
  // Only the request that wins the CAS enqueues, so concurrent submits can't
  // double-write or cross-contaminate the format.
  await topics.select(c.env.DB, run.id, picked);
  const claimed = await runs.claimWriteWithFormat(c.env.DB, run.id, outputFormat, formats);
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
  if (["image/png", "image/jpeg", "image/webp"].includes(ct)) filename = filename.replace(/\.(png|jpg|jpeg|webp)$/i, `.${imageExtension(ct)}`);
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

app.get("/articles/:id/seo", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!article) return c.notFound();
  const run = await runs.get(c.env.DB, article.run_id);
  const context = { outputFormat: isOutputFormat(article.output_format) ? article.output_format : "html", writingMode: run?.writing_mode } as const;
  return c.json({ review: seoDraftReview(article, context), schemaStarter: articleSchemaStarter(article, context) });
});

app.get("/articles/:id/inline-images/:file", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  const slot = /^([1-3])\.(png|svg)$/.exec(c.req.param("file"));
  if (!article || !slot) return c.notFound();
  const object = await c.env.ASSETS.get(inlineKey(article.id, Number(slot[1]), slot[2] as "png" | "svg"));
  if (!object) return c.notFound();
  return new Response(object.body, { headers: { "content-type": slot[2] === "svg" ? "image/svg+xml" : "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
});

app.get("/articles/:id/uploaded-images/:imageId", async (c) => {
  const article = await articles.getForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!article || !IMAGE_ID.test(c.req.param("imageId"))) return c.notFound();
  const image = runImages(await runs.get(c.env.DB, article.run_id)).find((item) => item.id === c.req.param("imageId"));
  if (!image) return c.notFound();
  return serveR2(c.env, image.r2_key, image.content_type, `uploaded-image.${imageExtension(image.content_type)}`);
});

app.get("/articles/:id/uploaded-images/:imageId/enhanced.png", async (c) => {
  const article = await articles.getForUser(c.env.DB,c.req.param("id"),c.get("user").id);
  if (!article || !IMAGE_ID.test(c.req.param("imageId"))) return c.notFound();
  const image = runImages(await runs.get(c.env.DB,article.run_id)).find((item) => item.id === c.req.param("imageId"));
  if (!image?.allow_enhance) return c.notFound();
  return serveR2(c.env,enhancedImageKey(article.id,image),"image/png","ai-enhanced-image.png");
});

app.get("/runs/:id/images/:imageId/notes", async (c) => {
  const run = await runs.getForUser(c.env.DB,c.req.param("id"),c.get("user").id);
  const image = runImages(run).find((item) => item.id === c.req.param("imageId"));
  if (!run || !image) return c.notFound();
  const saved = await loadVisual(c.env,image);
  if (!saved?.reading || saved.state !== "ready") return c.text(saved?.error || "Image reading has not finished yet.",409);
  return new Response(visualBody(saved.reading),{ headers: { "content-type":"text/markdown; charset=utf-8", "content-disposition":"attachment; filename=\"image-visual-notes.md\"" } });
});

app.post("/articles/:id/uploaded-images/:imageId/presentation",bodyLimit({maxSize:2048}),async (c) => {
  const article=await articles.getForUser(c.env.DB,c.req.param("id"),c.get("user").id);
  if (!article) return c.notFound();
  const run=await runs.get(c.env.DB,article.run_id);
  if (run?.state!=="ready") return c.json({error:"Wait for this run to finish before choosing a presentation."},409);
  const image=runImages(run).find((item)=>item.id===c.req.param("imageId"));
  if (!image?.allow_enhance || image.role==="attachment") return c.notFound();
  const job=await imageJobs.get(c.env.DB,article.id);
  if (job?.state==="queued" || job?.state==="working") return c.json({error:"Wait for the current image request to finish."},409);
  let variant:unknown;
  try {
    const payload=await c.req.json<{variant?:unknown;version?:unknown}>();variant=payload.variant;
    if (payload.version!==undefined && payload.version!==(article.content_version ?? 0)) return c.json({error:"This draft was updated in another tab. Reopen the latest draft before choosing its image."},409);
  } catch { return c.json({error:"Choose Original or Enhanced."},400); }
  if (variant!=="original" && variant!=="enhanced") return c.json({error:"Choose Original or Enhanced."},400);
  const checkpoint=await loadUploadedPlacements(c.env,article.id);
  const placement=checkpoint?.placements?.find((p)=>p.imageId===image.id);
  if (!checkpoint || placement?.enhanced!=="ready" || !await c.env.ASSETS.head(enhancedImageKey(article.id,image))) return c.json({error:"No enhanced copy is available. Your original is kept."},409);
  const target=variant==="enhanced" ? enhancedImageUrl(article.id,image) : uploadedImageUrl(article.id,image.id);
  const body_html=await new HTMLRewriter().on("img",{element(el){
    if (![enhancedImageUrl(article.id,image),uploadedImageUrl(article.id,image.id)].includes(el.getAttribute("src") || "")) return;
    const sourceWidth=variant==="enhanced" ? placement.width || image.width : image.width;
    const sourceHeight=variant==="enhanced" ? placement.height || image.height : image.height;
    const width=Math.min(sourceWidth,article.output_format==="email" ? 552 : article.output_format==="word" ? 600 : 760);
    el.setAttribute("src",target); el.setAttribute("width",String(width)); el.setAttribute("height",String(Math.max(1,Math.round(sourceHeight*width/sourceWidth))));
  }}).transform(new Response(article.body_html)).text();
  const format=isOutputFormat(article.output_format) ? article.output_format : "html";
  const output_body=isRichFormat(format) ? "" : renderOutput(body_html,format,{title:article.title,excerpt:article.excerpt,keyPhrases:parseKeyPhrases(article.key_phrases),maxWords:Number.MAX_SAFE_INTEGER}).body;
  const saved=await articles.updateIfCurrent(c.env.DB,article,{body_html,output_body,bundle_r2_key:null,...(image.role==="hero" ? {png_r2_key:variant==="enhanced" ? enhancedImageKey(article.id,image) : `articles/${article.id}/featured.png`} : {})});
  if (!saved) return c.json({error:"This draft changed while the image was being selected. Reopen the latest draft and choose the image again; your newer text is kept."},409);
  placement.selectedVariant=variant;
  try { await c.env.ASSETS.put(uploadedPlacementKey(article.id),JSON.stringify(checkpoint)); }
  catch { console.error(JSON.stringify({event:"presentation.checkpoint_delayed",article_id:article.id})); }
  await enqueueBundle(c.env,article.run_id,article.id);
  return c.json({ok:true,body_html,output_body,variant,version:(article.content_version ?? 0)+1});
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
    if (obj?.customMetadata?.bundleVersion === BUNDLE_VERSION && obj.customMetadata.fingerprint===await bundleFingerprint(a)) {
      return new Response(obj.body, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    }
    if (obj) await obj.body.cancel();
  }
  const zip = await buildBundle(c.env, a);
  // Rebuild the cache from the latest DB article off the request path, so a
  // concurrent edit cannot be overwritten by this download's older snapshot.
  c.executionCtx.waitUntil(enqueueBundle(c.env, a.run_id, a.id));
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
  let exportBody: string;
  try { exportBody = await exportInlineHtml(c.env, a); }
  catch (error) { if (error instanceof EmbeddedImageLimitError) return c.text(error.message,413); throw error; }
  const rendered =
    !isRichFormat(format) && format !== "markdown" && a.output_body
      ? { body: a.output_body, ext: "txt", mime: "text/plain; charset=utf-8" }
      : renderOutput(exportBody, format, { keyPhrases: parseKeyPhrases(a.key_phrases), title: a.title, excerpt: a.excerpt, maxWords: Number.MAX_SAFE_INTEGER });
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

  if (payload.version!==undefined && (!Number.isInteger(payload.version) || Number(payload.version)<0)) return c.json({error:"Invalid saved draft version. Reopen this article before saving."},400);
  if (payload.version!==undefined && payload.version!==(a.content_version ?? 0)) return c.json({error:"This draft was updated in another tab. Your unsaved text is still here: copy it, reopen the latest draft and merge your edits before saving."},409);

  // Body: re-run the exact same allowlist sanitizer + dash strip as generation.
  const bodyIn = typeof payload.body_html === "string" ? payload.body_html : a.body_html;
  const uploadedIds = runImages(await runs.get(c.env.DB, a.run_id)).map((image) => image.id);
  const body_html = stripDashes(await sanitizeHtml(bodyIn, a.id, uploadedIds));
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

  const saved=await articles.updateIfCurrent(c.env.DB, a, {
    title,
    body_html,
    meta_desc,
    excerpt,
    slug,
    key_phrases,
    output_body,
  });
  if (!saved) return c.json({error:"This draft changed while you were saving. Your newer saved draft is kept. Copy your unsaved text, reopen the latest draft and merge your edits."},409);

  // Rebuild the download bundle off the HTTP path (replay-safe queue job), so
  // the save returns immediately and heavy zip work never blocks the request.
  await enqueueBundle(c.env, a.run_id, a.id);

  // Return the canonical saved content so the editor can reconcile (sanitized
  // HTML, canonicalized slug, stripped dashes) rather than trust its local copy.
  return c.json({
    ok: true,
    bundle: "rebuilding",
    warnings,
    article: { title, body_html, meta_desc, excerpt, slug, key_phrases: keyPhraseList,version:(a.content_version ?? 0)+1 },
  });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await Promise.all([recoverStalledRuns(env), recoverOptionJobs(env), cleanDeletedAssets(env), env.DB.prepare("DELETE FROM login_attempts WHERE window_start<?").bind(Date.now() - 24 * 60 * 60_000).run(),env.DB.prepare("DELETE FROM image_read_leases WHERE lease_until<?").bind(Date.now()-86400000).run()]);
  },
  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};
