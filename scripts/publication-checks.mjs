/** Regression checks use temporary repositories and synthetic credentials only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scanner=fileURLToPath(new URL('./check-public.mjs',import.meta.url));
const exporter=readFileSync(new URL('./export-public.mjs',import.meta.url),'utf8');
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'presskit-publication-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function git(dir,...args){return execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});}
function init(dir){mkdirSync(dir,{recursive:true});git(dir,'init','-q');}
function scan(dir){return spawnSync(process.execPath,[scanner],{cwd:dir,encoding:'utf8'});}
const synthetic=()=> 'sk-'+'a'.repeat(40);
test('staged credentials cannot be hidden by cleaning or removing the working file',()=>fixture(dir=>{
 init(dir);writeFileSync(join(dir,'config.txt'),synthetic());git(dir,'add','.');
 writeFileSync(join(dir,'config.txt'),'clean');let result=scan(dir);assert.equal(result.status,1);assert.match(result.stderr,/index.*potential credential/);assert.ok(!result.stderr.includes(synthetic()));
 rmSync(join(dir,'config.txt'));assert.equal(scan(dir).status,1);
}));
test('clean staged and working files pass; untracked credentials and dangling symlinks fail',()=>fixture(dir=>{
 init(dir);writeFileSync(join(dir,'README.md'),'Public documentation');git(dir,'add','.');assert.equal(scan(dir).status,0);
 writeFileSync(join(dir,'untracked.txt'),synthetic());assert.equal(scan(dir).status,1);rmSync(join(dir,'untracked.txt'));
 symlinkSync(join(dir,'missing'),join(dir,'link'));assert.equal(scan(dir).status,1);
}));
test('a staged deletion of a private file can be removed safely',()=>fixture(dir=>{
 init(dir);writeFileSync(join(dir,'.env'),'synthetic');git(dir,'add','.env');git(dir,'rm','--cached','.env');rmSync(join(dir,'.env'));assert.equal(scan(dir).status,0);
}));
function exportFixture(dir){
 const source=join(dir,'source'),destination=join(dir,'destination');mkdirSync(join(source,'scripts'),{recursive:true});init(destination);
 for(const name of ['src','test','migrations','vendor','.github'])mkdirSync(join(source,name));
 for(const name of ['README.md','AGENTS.md','CLAUDE.md','CONTRIBUTING.md','SECURITY.md','LICENSE','.gitignore','package.json','package-lock.json','tsconfig.json','vitest.config.ts','eslint.config.js','wrangler.example.jsonc'])writeFileSync(join(source,name),'public');
 writeFileSync(join(source,'scripts/export-public.mjs'),exporter);
 return {source,destination,run:()=>spawnSync(process.execPath,[join(source,'scripts/export-public.mjs'),destination],{encoding:'utf8'})};
}
test('export refuses dirty worktrees without overwriting files',()=>fixture(dir=>{
 const f=exportFixture(dir);writeFileSync(join(f.destination,'README.md'),'uncommitted');assert.notEqual(f.run().status,0);assert.equal(readFileSync(join(f.destination,'README.md'),'utf8'),'uncommitted');
}));
test('export rejects ignored destination symlinks before copying',()=>fixture(dir=>{
 const f=exportFixture(dir);const outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(f.destination,'.git/info/exclude'),'src\n');symlinkSync(outside,join(f.destination,'src'));
 assert.notEqual(f.run().status,0);
}));
test('export copies source to a clean destination without private configuration',()=>fixture(dir=>{
 const f=exportFixture(dir);writeFileSync(join(f.source,'wrangler.jsonc'),'private operational settings');assert.equal(f.run().status,0);assert.equal(readFileSync(join(f.destination,'README.md'),'utf8'),'public');
 assert.throws(()=>readFileSync(join(f.destination,'wrangler.jsonc')));
}));

test('export stops nested private files before any copying',()=>fixture(dir=>{
 const f=exportFixture(dir);writeFileSync(join(f.source,'src/.env'),'synthetic private setting');assert.notEqual(f.run().status,0);assert.throws(()=>readFileSync(join(f.destination,'README.md')));
}));

test('scanner source itself does not trigger its synthetic-URL exception',()=>fixture(dir=>{
 init(dir);mkdirSync(join(dir,'scripts'));writeFileSync(join(dir,'scripts/check-public.mjs'),readFileSync(scanner));assert.equal(scan(dir).status,0);
}));
