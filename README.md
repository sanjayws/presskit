# Presskit

A self-hosted, source-grounded content studio on **Cloudflare Workers**. Build website articles, LinkedIn posts, email EDMs and WhatsApp/chat copy from briefs, web pages and uploaded documents. Export the results; Presskit never publishes them to external channels.

- Adapts six pinned, MIT-licensed [Claude SEO skills](https://github.com/AgriciDaniel/claude-seo) for intent-led briefs, people-first content, distinct metadata, readable explanations, images and an Article JSON-LD starter. [Source attribution and adaptation boundaries](vendor/claude-seo/README.md). Guidance runs within existing model calls; extra input tokens can affect cost.
- Checks whether sources support the brief before writing. When readable sources exist but evidence gaps remain, acknowledge the findings and choose **Ignore and continue** to move to angle selection without another readiness call. The original findings remain visible through export; the writer adapts around supported material and omits unsupported specifics without missing-source/process commentary in the publishable copy, and final editorial review still applies. Runs with no readable source require an upload or successful source retry.
- New generations plan scenarios, selectively research useful public context, draft, independently review, improve the complete draft at least once, and review again. Temporary failures resume saved steps; revisions remain bounded to three rounds. Existing in-progress checkpoints retain their previous workflow. If review still flags issues, inspect the saved draft and accept the exceptions to continue without additional writing/review calls, or request a paid recheck. Acceptance is tied to the exact saved content, recorded separately from automated approval, and leaves findings visible. Remaining image generation can still incur charges.
- **Auto decide** reads your brief, source pages, uploaded/saved documents and existing inputs in background, then fills suggested channels, writing mode, tone, length, creativity and visual settings. Highlighted suggestions require your review and submission; generation never starts automatically. Up to two active jobs and ten requests per hour per account; job requests, uploads and results expire after 24 hours.
- **Storytelling** builds a narrative with supported real situations or clearly illustrative scenarios. **Fictional story** creates labelled invented characters and events; pure fiction needs no sources, while real-world product/legal claims still do. Constructive framing, richer workplace scenarios and creative prose apply throughout, while retaining accurate material caveats.
- **Inline illustrations** optionally add 1–3 generated images beside relevant paragraphs in WordPress, email, Word and Markdown outputs, in addition to the hero. Social/chat keep the hero only. The AI chooses native SVG for appropriate process diagrams, timelines and concept cards in WordPress/Markdown, and PNG for illustrative scenes. SVG labels are checked against exact article passages, and application code builds the SVG from a restricted diagram specification. Email and Word use PNG for compatibility. One visual is generated per background step; SVGs use a text-model call instead of an OpenAI image call. ZIPs include the actual PNG/SVG files and local image paths; standalone downloads embed the selected assets. Clipboard images and embedded data URLs depend on the destination: upload ZIP images to your publishing/email platform and replace paths when needed. Failed inline images preserve the draft and other images. The writing mode and image-generation options are saved on each run; later brief edits apply to new runs.
- **Your images:** upload screenshots, photos or other PNG/JPEG/still WebP visuals. Choose one as the hero (skips paid hero generation), place others inside WordPress/HTML, Markdown, email or Word articles, or keep them as download-only attachments. Add descriptions for useful alt text and placement. Uploaded originals remain private, keep their original bytes/aspect ratio, stay visible when editing a brief, and are included in exports. Each run freezes its selection and descriptions; deselecting images for a new run preserves older articles. GPT-6 Luna reads original pixels and visible text before readiness; Claude uses those visual notes plus image tags and “Use this image when…” directions during planning, writing, review and placement. Notes are limited to observable details; a screenshot does not verify unseen behaviour or compliance. Each visual read and placement has up to three checkpointed attempts. Placements have a deterministic fallback. Generated illustrations are optional additions. See [image upload limits and workflow](#using-your-own-images).
- Runs in background queues with saved checkpoints and recovery.
- Select up to four destinations per run, such as WordPress + WhatsApp. Research is shared; each channel gets separate writing checkpoints, a draft, review, channel-sized visual and exports. Additional channels cost additional AI usage. Add channel-specific instructions to the brief; confirm destinations when choosing the angle. Existing single-channel runs remain supported.
- Generates channel-sized images and keeps previous versions. Planning and rendering prompts reserve crop-safe background: 20% at the top/bottom for landscape images, 30% for square images, and 10% at either side. Important subjects and text stay in the central area; verify the actual destination preview because image-model adherence and platform crops vary.
- Organises history into groups and archives; supports selective deletion.
- Supports **administrator-created email/password accounts in D1**, Google sign-in, or both.

## Deploy to Cloudflare

You need Node.js 22, npm, Python 3 (for account management), a Cloudflare account with Workers Paid and access to D1, R2, Queues, Browser Rendering and Workers AI, plus your own Anthropic/OpenAI API accounts. Provider usage and Cloudflare resources incur charges.

### 1. Clone and install

```bash
git clone git@github.com:sanjayws/presskit.git
cd presskit
npm ci --legacy-peer-deps
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler whoami
```

`wrangler.jsonc` is deliberately ignored: it contains **your** deployment settings. Never commit credentials, database dumps, real uploads or generated customer content.

### 2. Create resources

```bash
npx wrangler d1 create blog_studio
npx wrangler r2 bucket create blog-studio-assets
npx wrangler queues create pipeline
npx wrangler queues create pipeline-dlq
```

Copy the returned D1 `database_id` into `wrangler.jsonc`. If these resource names already exist for another application, choose unique names and update every matching database, bucket and producer/consumer/dead-letter queue entry in the config. Do not connect a new installation to someone else's resources.

### 3. Set your configuration

Edit `wrangler.jsonc`:

| Setting | What to enter |
|---|---|
| `name` | Your Worker name, e.g. `presskit` |
| `vars.APP_BASE_URL` | Its exact HTTPS URL, e.g. `https://presskit.YOUR-SUBDOMAIN.workers.dev`, without a trailing slash |
| `vars.ALLOWED_EMAIL_DOMAIN` | Your permitted email domain. Set `""` to allow any domain; with Google enabled this permits any verified Google account to join |
| `vars.PASSWORD_LOGIN_ENABLED` | `"true"` for administrator-managed email/password login |
| `vars.GOOGLE_CLIENT_ID` | Leave empty unless enabling Google in step 5 |
| AI model variables | Model IDs available to your API accounts; see below |
| `vars.READY_EMAIL_ENABLED` | Keep `"false"` unless configuring optional Postmark notifications |

Keep the supplied `DB`, `ASSETS`, `PIPELINE`, `BROWSER` and `DOCUMENTS` binding names, `nodejs_compat`, queue consumer, and five-minute cron. Enable the corresponding Cloudflare services/billing in your account if deployment reports unavailable bindings. For a custom domain, configure a Worker custom domain and use that exact URL for `APP_BASE_URL` and OAuth callbacks.

### 4. Store secrets and apply the schema

Create a session secret with a password manager or `openssl rand -hex 32`. Keep it private; rotating it signs everyone out. Wrangler prompts for values without putting them in the command itself:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler d1 migrations apply blog_studio --remote
```

If Wrangler asks to create the Worker during the first secret upload, accept. Use your chosen database name if you changed it. Apply **all** migrations, including `0019_password_login.sql`, `0020_multiple_channels.sql`, `0021_creative_generation.sql`, `0022_uploaded_images.sql` and `0023_image_narrative.sql`. When upgrading an existing installation, apply migrations before deploying the new Worker. Never insert plaintext passwords into D1 or configuration files.

### 5. Create a login

**Email/password (no Google account required):** run this from a terminal:

```bash
python3 scripts/manage-user.py writer@example.com --remote
```

Use a real email matching `ALLOWED_EMAIL_DOMAIN`. The command prompts for a 12–256-character password without echoing it, then stores only a random salt and PBKDF2-SHA256 hash in D1. Running it again resets the password and invalidates existing password sessions. There is no public signup, default password, or email-reset service. The administrator is responsible for verifying account ownership.

```bash
# Disable an account and invalidate its password sessions:
python3 scripts/manage-user.py writer@example.com --remote --disable
```

If you renamed the database, append `--database YOUR_DATABASE`. Use `--local` instead of `--remote` for local D1. Account and IP attempt limits apply to password login. Disabling a password account does not disable Google access; remove provider access or adjust your workspace domain policy separately.

**Optional Google sign-in:** create a Web application OAuth client in Google Cloud. Register `https://YOUR-APP-HOST/auth/callback` as its authorised redirect URI, configure the consent screen/test users as required, put its client ID in `vars.GOOGLE_CLIENT_ID`, then run:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Google is not required for password login. Set `PASSWORD_LOGIN_ENABLED` to `"false"` for Google-only access. Verified emails identify the same workspace user across both methods. Sessions use secure, HttpOnly cookies and expire after seven days.

### 6. Check and deploy

```bash
npm run cf-typegen
npm run typecheck
npm run lint
npm test
npx wrangler deploy --dry-run
npx wrangler deploy --keep-vars
```

The deploy output shows your URL. If it differs from `APP_BASE_URL`, correct the config and deploy again. Never configure `DEV_AUTH_EMAIL` on a deployed Worker: it bypasses authentication.

### 7. Verify the installation

1. Open `https://YOUR-APP-HOST/healthz`; expect `{"ok":true}`.
2. Open `/auth/login` and sign in with your provisioned account or Google.
3. Create a short brief (optionally use Auto decide and review the filled settings) with a readable supporting text file (40–60,000 characters).
4. Confirm readiness, choose an angle and up to four destinations, and wait for review and image generation. Leave and reopen the run to verify background progress.
5. Check source downloads, image history and export. If a provider fails, use the specific run diagnostic; check model access, billing and secrets before retrying.

### 8. Optional ready emails

Set `READY_EMAIL_ENABLED` to `"true"`, add `POSTMARK_TOKEN` and `POSTMARK_FROM` with `wrangler secret put`, use a sender verified by Postmark, and redeploy. Notifications contain a draft title and private result link. They do not send the full article or publish it anywhere.

## Models and limits

The supplied configuration retains these model choices: Anthropic `claude-opus-5-5` with low effort for planning/writing/review/image suggestions; OpenAI `gpt-6-luna` for readiness and document extraction; OpenAI `gpt-image-2.5-sunburst` for images. **Availability depends on your provider account.** These are configuration choices, not a promise that every account can access them. Changing model IDs alone may not make other models compatible with the response schemas, tools or reasoning settings. Readiness currently uses a fixed Luna ID; its Decisions endpoint falls back to structured Responses when the endpoint is unsupported.

| Input | Limit |
|---|---|
| Supporting document upload | One new document per submission, at most 10,000,000 bytes |
| Own images | Up to 6 selected files including saved images; PNG, JPEG or still WebP |
| Own image size | At most 3,000,000 bytes each; at most 10,000,000 bytes combined |
| Own image dimensions | At most 8,192 pixels per side and 24 megapixels |
| Image description / alt text | 1–240 characters; new files default to their filename when omitted |
| Image tag / usage instruction | Unique tag: 1–40 characters; “Use this image when…”: up to 240 characters |
| Visual reading | One original per background step; up to three attempts; cached per saved image |
| Optional enhancements | Up to two AI-edited copies per output, only for opted-in images |
| Embedded standalone export | Up to 12,000,000 bytes of inline image data; larger collections use ZIP files and local paths |
| Extracted document text | 40–60,000 characters; no fixed page limit |
| Source URLs field | 10 URLs, 4,096 characters each; optional writing research can add up to two more extracted public sources |
| Brief | 12,000 characters |
| Include / avoid fields | 6,000 characters each |
| Evidence supplied to readiness/writing | 60,000 characters combined; relevant excerpts are selected for larger collections |
| Output | Up to 2,000 words, with shorter channel-specific limits |

Uploads support PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, CSV, TXT, HTML and Markdown. Saved files stay attached when editing. File size/type, brief limits and readable text limits are checked before queueing where possible; PDF/Office content limits are checked during extraction before readiness. PDF extraction can itself use an AI request. Excerpt selection can miss supporting details. Review generated facts and images before publication.

## Using your own images

1. Open **Your images** in the brief. Select an image, choose **Hero image**, **Inside article** or **Download only**, describe what it shows, give it a unique **Image tag**, and enter **Use this image when…** (for example, “Use routing-screen when explaining the Sales pilot setup”). Use **Add another image** for more files.
2. Choose at most one uploaded hero. With no uploaded hero, Presskit generates one. **Generated inline illustrations → No additional AI images** keeps only your uploads and the hero; choose 1–3 to add AI illustrations.
3. Submit the brief and choose your angle/channels. Before readiness, the existing OpenAI document model reads the original pixels into bounded visual observations and visible-text transcription. These become explicitly labelled source records for observable details. Claude receives the notes and tag/usage map for planning, narrative writing, review and placement. An image-only brief can proceed when its visible content supports the request; unreadable or unsupported claims still need readable evidence. Small text and OCR can be wrong: inspect **View AI reading** and the original.
4. Review the draft and **Your uploaded images** gallery. Download originals individually, or use **Download all** for the article, image files and `uploaded-images.json` descriptions/roles. LinkedIn, social/chat and plain text keep uploads as separate attachments. Inside-article files are embedded in standalone downloads and referenced by local filenames in ZIPs. Clipboard/data-URL support varies; upload the files to your destination media library and replace paths where needed.
5. Optionally check **Allow AI to enhance presentation if useful**. Claude decides whether framing, background or visual focus would help, and the configured OpenAI image model receives the actual original through the image-edits API. Up to two edits per output, one per background step, with at most three attempts. Originals remain the factual sources. Enhanced copies are labelled, retained separately, and need checking for changed text/UI; switch with **Use original** / **Use enhanced copy** without generating again. A failed edit uses the original.
6. When editing the brief, keep the checked saved images or deselect them for the next run. Older runs keep their own image selection and descriptions. Deleting a brief or its final history item schedules removal of its private uploads.

Browser count/size/type checks run before submission, and the server validates the selection, headers and dimensions before queueing AI work (including Auto decide). Email/Word hero and inline visuals require PNG/JPEG; WebP can stay as a download-only attachment. This compatibility check applies both to brief submission and channel selection. SVG, GIF/APNG, animated WebP and HEIC uploads are not supported; export a still PNG/JPEG/WebP copy. Original files are not resized, cropped, stripped of metadata or redacted. Selected original pixels are sent to the configured OpenAI document model for visual reading; opted-in originals can also be sent to the OpenAI image model for editing. Claude receives visual notes, tags and usage instructions. Auto decide reads images too; a successful reading is reused on submission only for the same account and identical file bytes. Editing tags/usage does not reread unchanged saved pixels. ZIPs include the originals, available enhanced copies and visual-reading Markdown. Standalone embedded downloads stop at 12 MB of inline image data with an actionable ZIP fallback to keep memory bounded. Remove confidential details yourself and check each destination's crop and file requirements; uploaded heroes do not receive generated crop-safe padding. Inline display dimensions preserve aspect ratio and fit article/email widths. No additional Cloudflare binding or API key is needed beyond migrations `0022_uploaded_images.sql` and `0023_image_narrative.sql`.

## SEO guidance and publishing

Website/article outputs get an optional **SEO & publishing suggestions** panel
and owner-scoped JSON at `/articles/<id>/seo`. These are draft checks, not Google
scores; they never block generation. Fiction, email and social/chat retain their
own writing structure. Storytelling keeps its narrative flow. No keyword density
target, word-count floor, fabricated expertise, guaranteed ranking or AI citation.

Fresh ZIP downloads include `seo-checklist.json` and publishing notes for eligible
article outputs. WordPress/HTML ZIPs include `article-schema.json`, an **incomplete
Article JSON-LD starter** with saved headline, description and word count only.
Supply the real author, publisher, public page/image URLs and accurate dates from
your CMS; avoid duplicate/conflicting schema if a CMS plugin already emits it.
Validate structured data and check indexing, canonical URLs and page performance
on the destination site. These cannot be established from an unpublished draft.
Existing cached ZIPs upgrade on download without rewriting or generating images.
New inline images preserve actual PNG/SVG dimensions to reserve layout space.

Skill entrypoints and licenses are vendored at a pinned revision and checked by
`npm run skills:verify`; upstream installers, scripts, multi-agent runners and paid
extensions are not executed. Updates require review. See the
[adapter map](vendor/claude-seo/README.md) for scope and omitted upstream rules.

## Architecture and development

Hono/TypeScript Worker → D1 metadata and R2 private files → Queues for ingestion, readiness, drafting, review and image generation. D1 checkpoints and a scheduled watchdog recover interrupted hand-offs. Browser Rendering assists public-page extraction; it does not bypass sign-in. External service failures remain possible. No vector database is required.

```bash
npx wrangler d1 migrations apply blog_studio --local
npm run dev
```

For local-only work, create an ignored `.dev.vars` containing `DEV_AUTH_EMAIL=developer@example.com` and your local provider secrets if making real API requests. Tests use synthetic fixtures and mocked providers; `npm test` does not require real keys. Local remote-service bindings may require a Cloudflare preview for full integration testing. Do not use production customer data in public test fixtures.

## Maintenance and security

For every future patch: update tests, update this README when behaviour/setup changes, review the exact diff for secrets/confidential data, and commit/push to `git@github.com:sanjayws/presskit.git` over SSH. The standing contributor instructions are in [AGENTS.md](AGENTS.md). CI runs tests, a publication scan and a bundle check; it does not deploy or require production secrets.

Run `node scripts/check-public.mjs` on the publication tree before pushing. It checks both staged Git content and working files, including untracked files. If working in a private operational directory, use `node scripts/export-public.mjs /path/to/clean-checkout` to copy only the maintained source allowlist into a clean checkout; uncommitted changes and destination symlinks stop the export before copying. The helper never copies live Wrangler config, internal audits, uploads or local state. Inspect `git diff --cached` before every push. A scan is an additional check, not a substitute for reviewing content.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and [CONTRIBUTING.md](CONTRIBUTING.md) for checks. MIT licensed; third-party notices remain in [vendor/](vendor/).

References: [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
