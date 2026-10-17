/** Offline provenance check; does not fetch or execute upstream skills. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../vendor/marketingskills/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const ids = ['content-strategy', 'copywriting', 'copy-editing', 'ai-seo', 'social', 'image'];
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.license, 'MIT');
assert.deepEqual(manifest.skills.map(skill => skill.id).sort(), [...ids].sort());
const runtime = readFileSync(new URL('../src/marketing/skills.ts', import.meta.url), 'utf8');
assert.ok(runtime.includes(`export const MARKETING_SKILLS_COMMIT = "${manifest.commit}"`));
assert.ok(runtime.includes(`export const MARKETING_SKILLS_VERSION = "${manifest.runtimeAdapterVersion}"`));
assert.ok(readFileSync(new URL('LICENSE', root), 'utf8').includes('Copyright (c) 2025 Corey Haines'));
for (const skill of manifest.skills) {
  assert.ok(ids.includes(skill.id));
  const source = readFileSync(new URL(`skills/${skill.id}/SKILL.md`, root));
  assert.equal(createHash('sha256').update(source).digest('hex'), skill.sha256, `${skill.id}: source checksum`);
  assert.match(source.toString(), new RegExp(`^  version: ${skill.version.replaceAll('.', '\\.')}\\r?$`, 'm'), `${skill.id}: source version`);
}
console.log(`Verified ${ids.length} MIT-licensed skill entrypoints at ${manifest.commit}; runtime ${manifest.runtimeAdapterVersion}.`);
