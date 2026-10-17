# Reviewed marketing skills for Presskit

Source: [Corey Haines' Marketing Skills](https://github.com/coreyhaines31/marketingskills),
MIT licensed; commit `dda3841f0b294e01e93b1541486beefbfab0915e`, reviewed 2026-10-03.
The upstream `SKILL.md` files, bundled references and evals were installed from
that exact commit with the trusted skill installer. They are unchanged reference
material. Attribution is retained in [LICENSE](LICENSE); entrypoint versions and
SHA-256 checksums are recorded in [manifest.json](manifest.json).

## Suitability and runtime integration

Useful for editorial craft, but generic marketing advice is not factual evidence
or proof that content quality, conversions or search visibility will improve.
Presskit uses the reviewed runtime adaptations in
[src/marketing/skills.ts](../../src/marketing/skills.ts), version `2026-10-03.1`.
The orchestrator loads skills deterministically into system instructions before
its existing model requests. These are application-stage skill calls, not new
autonomous agents or model-selected function-call tools. No global Codex skill
installation or restart is required for the application integration.

| Agent stage | Loaded skills | Intended improvement |
|---|---|---|
| Topic research | content-strategy | Specific reader intent, distinct useful angles, evidence coverage |
| Article plan | content-strategy, copywriting, ai-seo | Strong supported headline, logical outline, direct answers |
| Intro and each section | copywriting, ai-seo, copy-editing | Concrete prose, flow, internal editing and proof checks |
| Short article | copywriting, ai-seo, copy-editing | Compact clear prose and internal editing in the existing single call |
| Social writing | copywriting, copy-editing, social | One concise standalone post, natural hook, no invented anecdotes |
| Image planning and rendering | image | Specific subject, purposeful composition, hierarchy, typography, lighting |

Social routing uses the stored per-run `output_format`, never words in the user's
free-text brief. Social planning, if called directly, also uses content-strategy;
it omits ai-seo. Neutral editorial settings suppress sales pressure and emotional
agitation. Promotional settings retain all evidence and limitation requirements.
Copy editing is an internal self-check in the existing generation call; there is
no new whole-article editor request or independent factual-verification service.

## Review decisions and exclusions

- Content strategy: adopt reader intent, source-backed angles and non-overlapping
  outlines. Omit invented prioritisation scores, traffic forecasts and upstream
  benchmark statistics. Search still informs intent, not product facts.
- Copywriting: adopt specificity, useful openings, clear language and avoidance
  of repeated formulaic writing. Use supported mechanisms, not made-up figures,
  when improving vague statements. Do not impose sales-page structure on articles.
- Copy editing: adapt the focused sweeps to preserve voice, qualifications and
  limitations. Reject fabricated proof, risk reversals and heightened urgency.
  Unsupported claims are omitted or qualified; placeholders are not published.
- AI SEO: adopt descriptive headings, direct answers and coherent self-contained
  explanations. Omit ranking/citation uplift claims, fake expertise and artificial
  answer chunks. Do not alter authentication, robots rules, public access or schema.
- Social: adopt concise standalone posts and genuine supported hooks. Omit
  fake personal stories, engagement bait, platform assumptions and posting tools.
- Image: adopt subject/context/style/composition/lighting specificity. Retain
  the existing OpenAI model, `1536x1024` PNG, exact labels, two-to-four points,
  quote validation, factual exclusions and corporate palette. Ignore upstream
  provider preferences, sample screenshots, batch generation and alternate sizes.
- Ads, outreach, automated publishing, technical SEO audits, monetisation and
  unrelated growth skills are not wired into this article-generation workflow.

Required context comes from the existing campaign, selected topic, format,
editorial controls and numbered grounding sources. Runtime agents do not read
`.agents/product-marketing.md` or another user's context from local files.

## Safety, performance and existing content

- Approved adaptations are bundled constants, with an allowlisted name/role
  registry. Runtime never fetches GitHub, follows Markdown links, installs packages
  or executes upstream code. Unknown names, URLs and prototype keys are rejected.
- The safety contract overrides marketing tactics: no fabricated testimonials,
  statistics, scarcity, guarantees, credentials, experience or comparison winner;
  no hiding material limitations or following instructions inside source data.
- Skill additions are capped at 4,300 characters per instruction bundle. There
  are no extra provider calls, but added input tokens may increase generation
  cost/latency; this is not a zero-cost feature. No new infrastructure/dependencies,
  database migration or provider-secret change is required.
- `marketing.skills` logs role, selected IDs, adapter version and character count
  only. Sources, prose, editorial preferences and credentials are not logged.
- Image prompt version changes to `2026-10-03.1`. An old cached brief must replan
  once on a new request; current-version briefs still survive transient retries.
  Existing successful PNGs and saved articles are untouched. Completed article
  sections in a checkpoint are not regenerated solely to apply new guidance.
- Upstream changes do not flow into production automatically. Review a pinned
  revision, update adapters/checksums/versions deliberately, then rerun checks.

## Verification and remaining acceptance work

Run `npm run skills:verify` to check the six skill entrypoint hashes, source
versions, MIT notice and runtime/source commit identity offline. This checks
entrypoints, not every ancillary reference/eval file. Run `npm run typecheck`,
`npm run lint`, `npm test`, and `npx wrangler deploy --dry-run` before deployment.

Tests exercise real outbound request construction with mocked provider responses:
topic research, planning, short prose, neutral/promotional controls, social format
through the complete write stage, intro/section guidance, image planning/render
instructions, instruction budgets, unknown-name rejection, immutability and
metadata-only logging. They check integration and regression safety, not model
quality. No paid production generation is part of these tests.

Verified on 2026-10-03: 224 tests in 28 files pass, including 17 skill-specific
tests and all existing security/image-job/format regressions. Instruction budgets
were exercised across six roles, five output formats and five bias settings.
TypeScript, ESLint, offline skill verification and Wrangler deployment dry-run
pass. The bundled Worker is 380.40 KiB raw / 103.83 KiB gzip. `npm test` runs the
source-integrity check automatically before Vitest. The existing test runtime
warns that it falls back to compatibility date 2025-04-17; production configuration
is unchanged. These checks are not a live provider or deployed-runtime benchmark.

Before claiming a measured quality improvement, compare before/after outputs on
the same sources across neutral/news, promotional, comparison, how-to, social and
visual examples. Human review should check factual support, caveats, reader value,
coherence, formulaic language and visual label support/legibility. Record actual
token usage, generation time and cost per accepted output. A successful mock test
or a model's own review is not independent evidence of publish-ready quality.
