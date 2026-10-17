/** Scan both the Git index and working files; never print matching secret values. */
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
function git(args) {
  try { return execFileSync('git',args,{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']}); }
  catch { throw new Error('Unable to inspect Git publication data. Run from the repository root.'); }
}
const entries=git(['ls-files','--stage','-z']).split('\0').filter(Boolean);
const others=git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
const files=new Set(others),issues=[];
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[A-Z0-9]{16}\b/, /https?:\/\/[^\s/@]+:[^\s/@]+@/];
function scan(file,content,location){
  if(/(^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|wrangler\.jsonc|\.aws|\.codex|\.claude|\.serena|\.wrangler|review)(?:\/|$)/.test(file)||/\.(?:pem|key|p12|sqlite|db|zip|tgz)$/.test(file))issues.push(`${file} (${location}): private/local file`);
  // Exact synthetic SSRF fixture; other values in tests are still scanned.
  if(file==='test/validate.test.ts')content=content.replace('https://' + 'user:pw@' + 'example.com','synthetic-invalid-url');
  if(patterns.some(pattern=>pattern.test(content)))issues.push(`${file} (${location}): potential credential`);
}
for(const entry of entries){
  const match=/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
  if(!match)throw new Error('Invalid Git index metadata.');
  const [,mode,oid,stage,file]=match;files.add(file);
  if(stage!=='0'||mode==='120000'||mode==='160000'){issues.push(`${file} (index): unresolved merge, symlink or submodule`);continue;}
  scan(file,git(['cat-file','blob',oid]),'index');
}
for(const file of files){
  // An unstaged deletion still has its indexed bytes scanned above.
  let info;try{info=lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(info.isSymbolicLink()){issues.push(`${file} (working tree): symlink`);continue;}
  scan(file,readFileSync(file,'utf8'),'working tree');
}
if(issues.length){console.error([...new Set(issues)].join('\n'));process.exit(1);}
console.log(`Publication scan passed for ${files.size} files, including staged content. Review confidential content and the staged diff too.`);
