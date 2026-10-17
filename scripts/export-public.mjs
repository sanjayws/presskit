/** Copy reviewed source areas only. Never copy live configuration or operational data. */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const source = resolve(new URL('..', import.meta.url).pathname);
const destination = resolve(process.argv[2] || '');
if (!process.argv[2] || destination === source || !existsSync(join(destination, '.git'))) throw new Error('Supply a separate Git checkout as the destination.');
const entries = ['src','test','migrations','vendor','scripts','.github','README.md','AGENTS.md','CLAUDE.md','CONTRIBUTING.md','SECURITY.md','LICENSE','.gitignore','package.json','package-lock.json','tsconfig.json','vitest.config.ts','eslint.config.js','wrangler.example.jsonc'];
function check(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('Symlinks are not permitted in publication sources.');
  if (info.isDirectory()) for (const name of readdirSync(path)) {
    if (name === '__pycache__') continue;
    check(join(path,name));
  }
}
for (const entry of entries) {
  const path = join(source,entry); check(path);
  mkdirSync(destination,{recursive:true});
  cpSync(path,join(destination,entry),{recursive:true,filter:path=>!path.includes('__pycache__')});
}
console.log('Public source copied. Review additions AND deletions against the source, stage the intended changes, then run check-public.mjs. Nothing was committed or pushed.');
