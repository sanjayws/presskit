# Presskit

A self-hosted, source-grounded content studio on **Cloudflare Workers**. Build website articles, LinkedIn posts, email EDMs and WhatsApp/chat copy from briefs, web pages and uploaded documents. Export the results; Presskit never publishes them to external channels.

- Checks whether sources support the brief before writing.
- Plans, writes, independently reviews and revises drafts with bounded retries.
- Runs in background queues with saved checkpoints and recovery.
- Generates channel-sized images and keeps previous versions.
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

If Wrangler asks to create the Worker during the first secret upload, accept. Use your chosen database name if you changed it. Apply **all** migrations, including `0019_password_login.sql`. Never insert plaintext passwords into D1 or configuration files.

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
3. Create a short brief with a readable supporting text file (40–60,000 characters).
4. Confirm readiness, choose an angle, and wait for review and image generation. Leave and reopen the run to verify background progress.
5. Check source downloads, image history and export. If a provider fails, use the specific run diagnostic; check model access, billing and secrets before retrying.

### 8. Optional ready emails

Set `READY_EMAIL_ENABLED` to `"true"`, add `POSTMARK_TOKEN` and `POSTMARK_FROM` with `wrangler secret put`, use a sender verified by Postmark, and redeploy. Notifications contain a draft title and private result link. They do not send the full article or publish it anywhere.

## Models and limits

The supplied configuration retains these model choices: Anthropic `claude-opus-5-5` with low effort for planning/writing/review/image suggestions; OpenAI `gpt-6-luna` for readiness and document extraction; OpenAI `gpt-image-2.5-sunburst` for images. **Availability depends on your provider account.** These are configuration choices, not a promise that every account can access them. Changing model IDs alone may not make other models compatible with the response schemas, tools or reasoning settings. Readiness currently uses a fixed Luna ID; its Decisions endpoint falls back to structured Responses when the endpoint is unsupported.

| Input | Limit |
|---|---|
| New upload | One file per submission, at most 10,000,000 bytes |
| Extracted document text | 40–60,000 characters; no fixed page limit |
| Source URLs field | 10 URLs |
| Brief | 12,000 characters |
| Include / avoid fields | 6,000 characters each |
| Evidence supplied to readiness/writing | 60,000 characters combined; relevant excerpts are selected for larger collections |
| Output | Up to 2,000 words, with shorter channel-specific limits |

Uploads support PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, CSV, TXT, HTML and Markdown. Saved files stay attached when editing. File size/type, brief limits and readable text limits are checked before queueing where possible; PDF/Office content limits are checked during extraction before readiness. PDF extraction can itself use an AI request. Excerpt selection can miss supporting details. Review generated facts and images before publication.

## Architecture and development

Hono/TypeScript Worker → D1 metadata and R2 private files → Queues for ingestion, readiness, drafting, review and image generation. D1 checkpoints and a scheduled watchdog recover interrupted hand-offs. Browser Rendering assists public-page extraction; it does not bypass sign-in. External service failures remain possible. No vector database is required.

```bash
npx wrangler d1 migrations apply blog_studio --local
npm run dev
```

For local-only work, create an ignored `.dev.vars` containing `DEV_AUTH_EMAIL=developer@example.com` and your local provider secrets if making real API requests. Tests use synthetic fixtures and mocked providers; `npm test` does not require real keys. Local remote-service bindings may require a Cloudflare preview for full integration testing. Do not use production customer data in public test fixtures.

## Maintenance and security

For every future patch: update tests, update this README when behaviour/setup changes, review the exact diff for secrets/confidential data, and commit/push to `git@github.com:sanjayws/presskit.git` over SSH. The standing contributor instructions are in [AGENTS.md](AGENTS.md). CI runs tests, a publication scan and a bundle check; it does not deploy or require production secrets.

Run `node scripts/check-public.mjs` on the publication tree before pushing. If working in a private operational directory, use `node scripts/export-public.mjs /path/to/clean-checkout` to copy only the maintained source allowlist; it never copies live Wrangler config, internal audits, uploads or local state. Inspect `git diff --cached` before every push. A scan is an additional check, not a substitute for reviewing content.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and [CONTRIBUTING.md](CONTRIBUTING.md) for checks. MIT licensed; third-party notices remain in [vendor/](vendor/).

References: [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
