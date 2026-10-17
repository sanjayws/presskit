/** Copy reviewed source areas only. Never copy live configuration or operational data. */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, basename } from 'node:path';
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = resolve(process.argv[2] || '');
if (!process.argv[2] || destination === source || !existsSync(join(destination, '.git'))) throw new Error('Supply a separate Git checkout as the destination.');
if (lstatSync(destination).isSymbolicLink()) throw new Error('Destination must not be a symlink.');
const status = execFileSync('git',['-C',destination,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'});
if (status.trim()) throw new Error('Destination has uncommitted work. Commit or preserve it before exporting.');
const entries = ['src','test','migrations','vendor','scripts','.github','README.md','AGENTS.md','CLAUDE.md','CONTRIBUTING.md','SECURITY.md','LICENSE','.gitignore','package.json','package-lock.json','tsconfig.json','vitest.config.ts','eslint.config.js','wrangler.example.jsonc'];
function check(path) {
  const info = lstatSync(path);
  if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|wrangler\.jsonc)$/.test(basename(path)) || /\.(?:pem|key|p12|sqlite|db|zip|tgz)$/.test(path)) throw new Error("Private files are not permitted inside publication sources.");
  if (info.isSymbolicLink()) throw new Error('Symlinks are not permitted in publication sources.');
  if (info.isDirectory()) for (const name of readdirSync(path)) {
    if (name === '__pycache__') continue;
    check(join(path,name));
  }
}
// Preflight every destination before writing anything, including ignored links.
for (const entry of entries) {
  check(join(source,entry));
  let present = false;
  try { lstatSync(join(destination,entry)); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (present) check(join(destination,entry));
}
for (const entry of entries) {
  const path = join(source,entry);
  mkdirSync(destination,{recursive:true});
  cpSync(path,join(destination,entry),{recursive:true,filter:path=>!path.includes('__pycache__')});
}
console.log('Public source copied. Review additions AND deletions against the source, stage the intended changes, then run check-public.mjs. Nothing was committed or pushed.');
