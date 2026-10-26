# Reviewed Claude SEO source snapshot

Upstream: https://github.com/AgriciDaniel/claude-seo. The exact revision, six
unchanged skill entrypoints and SHA-256 checksums are in `manifest.json`. MIT
notice is retained in `LICENSE`; skill frontmatter preserves contributor credits,
including the content-brief contribution by puneetindersingh.

These files are reference material, not executable runtime skills. Presskit's
reviewed adaptations are in `src/seo/skills.ts` and `src/seo/review.ts`. No upstream
installer, Python script, Claude Code command, agent runner, paid extension or
remote skill download is executed. Updates require an explicit review and pin.
Relative references in the original entrypoints describe the upstream repository;
they are not runtime dependencies. Only the six entrypoints are vendored.

| Upstream skill | Presskit adaptation |
|---|---|
| seo-content-brief | Reader intent, credible scope, distinct section jobs and useful information gain in research/planning/Auto decide |
| seo-page | Descriptive titles, distinct descriptions, sensible headings, known links and draft metadata checks |
| seo-content | Useful specificity, honest attribution, source-backed experience and substantive editing |
| seo-geo | Clear entities, readable explanations and supported answer passages without artificial chunks or citation promises |
| seo-images | Descriptive alt text, natural topic relevance and intrinsic dimensions for generated inline visuals |
| seo-schema | A factual Article JSON-LD starter and explicit publishing prerequisites; no fabricated author/site/date/image identities |

Adaptation boundaries:

- Existing briefs, source evidence, narrative mode, channel budgets and supported
  output schemas take precedence. Social/email/chat and pure fiction do not get
  website SEO guidance or an Article schema starter.
- Character ranges are optional drafting heuristics, never hard gates. No keyword
  density target, word-count floor, fabricated E-E-A-T score, SERP position,
  competitor score or guaranteed ranking/AI citation. SEO suggestions never add
  a generation failure gate or bypass the user's saved-draft exceptions.
- Preserve storytelling and positive framing. Never invent first-hand experience,
  expert credentials, statistics, testimonials, citations or publication dates.
- No mandatory FAQ, no arbitrary snippet-length blocks, no automatic site audit,
  indexing submission, publishing, traffic analytics or technical SEO claims about
  an unpublished draft. Search Console, canonical URLs, robots, page speed and
  rich-result validation remain tasks for the destination website.
- Reviewed instructions are capped at 2,400 characters per role and added to
  existing provider calls. Added input tokens can cost more; no extra model call
  is introduced. Logs contain role, skill IDs, version and character count only.
- The SEO checklist is deterministic draft guidance, not a search-engine score.
  Article JSON-LD is an optional starter requiring a real author, publisher,
  public URL/image and dates from the publishing site, plus human validation.

`npm run skills:verify` verifies both upstream snapshots offline. Integration tests
inspect actual provider request construction and preserve channel/fiction routing.
Tests establish integration and safety; they do not prove a measured ranking or
writing-quality improvement. Compare outputs against the same briefs and sources
before making outcome claims.
