# Standing project instructions

- Maintain Presskit as a public open-source project. The canonical repository is
  git@github.com:sanjayws/presskit.git. Use SSH for pushes.
- For every future patch/fix, complete relevant checks, update README.md if setup,
  configuration, limits, authentication or behaviour changes, then commit and push
  the reviewed public-safe changes. Never force-push or rewrite history without
  explicit authorization. If push is blocked, report the exact blocker.
- Never publish real secrets, password hashes, emails/customer content, generated
  production artifacts, database exports, internal audits, local tooling state,
  production identifiers or live Wrangler configuration. Publish only placeholders
  in wrangler.example.jsonc. Do not paste credentials into logs, issues or chat.
- The private operational workspace may have an inaccessible .git directory. Use
  a normal isolated clone and scripts/export-public.mjs; review the staged diff and
  run scripts/check-public.mjs before committing. Preserve existing remote work.
- Keep D1 administrator-provisioned email/password login functional without Google.
  Store salted hashes only; retain same-origin login protection, attempt limits,
  secure cookies and session revocation after password reset/disable.
- Preserve export-only behaviour, grounding, bounded review/retry loops, owner-scoped
  access, source prechecks, saved uploads, image versions and background recovery.
- Run npm run typecheck, npm run lint, npm test and the Wrangler dry run before release.
  Apply required migrations before deploying code that uses the new tables.
- Keep third-party licenses and provenance. Read README.md for exact deployment steps.
