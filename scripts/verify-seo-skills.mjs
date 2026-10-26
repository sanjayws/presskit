/** Offline verification of the pinned, non-executable Claude SEO reference snapshot. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../vendor/claude-seo/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const ids = ['seo-content-brief', 'seo-page', 'seo-content', 'seo-geo', 'seo-images', 'seo-schema'];
assert.equal(manifest.repository, 'https://github.com/AgriciDaniel/claude-seo');
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.license, 'MIT');
assert.deepEqual(manifest.skills.map(s => s.id).sort(), [...ids].sort());
const runtime = readFileSync(new URL('../src/seo/skills.ts', import.meta.url), 'utf8');
assert.ok(runtime.includes(`SEO_SKILLS_COMMIT = "${manifest.commit}"`));
assert.ok(runtime.includes(`SEO_SKILLS_VERSION = "${manifest.runtimeAdapterVersion}"`));
assert.ok(readFileSync(new URL('LICENSE', root), 'utf8').includes('Copyright (c) 2026 agricidaniel'));
for (const skill of manifest.skills) {
  assert.ok(ids.includes(skill.id));
  const source = readFileSync(new URL(`skills/${skill.id}/SKILL.md`, root));
  assert.equal(createHash('sha256').update(source).digest('hex'), skill.sha256, `${skill.id}: source checksum`);
  assert.match(source.toString(), /^license: MIT$/m);
  assert.match(source.toString(), new RegExp(`^  version: "${skill.version.replaceAll('.', '\\.')}"$`, 'm'));
}
console.log(`Verified ${ids.length} MIT Claude SEO entrypoints at ${manifest.commit}; runtime ${manifest.runtimeAdapterVersion}.`);
