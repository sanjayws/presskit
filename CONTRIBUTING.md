# Contributing

Use Node.js 22. Copy `wrangler.example.jsonc` to ignored `wrangler.jsonc` and run
`npm ci --legacy-peer-deps`. Tests use synthetic data and mocked provider calls.

Before submitting: `npm run typecheck`, `npm run lint`, `npm test`,
`npx wrangler deploy --dry-run`, and `node scripts/check-public.mjs`.
Update README.md for changed setup, behaviour or limits. Include meaningful tests
for authentication, data isolation, queue recovery and provider-handling changes.

Do not include real keys, users, password hashes, source documents or production
configuration. Preserve vendor licenses. Follow AGENTS.md for the release workflow.
