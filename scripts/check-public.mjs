/** Inspect candidate Git files; never print matching secret values. */
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const files = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const issues=[];
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[A-Z0-9]{16}\b/, /https?:\/\/[^\s/@]+:[^\s/@]+@/];
for(const file of [...new Set(files)]) {
  if(/(^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|wrangler\.jsonc|\.aws|\.codex|\.claude|\.serena|\.wrangler|review)(?:\/|$)/.test(file)||/\.(?:pem|key|p12|sqlite|db|zip|tgz)$/.test(file))issues.push(`${file}: private/local file`);
  if(lstatSync(file).isSymbolicLink()){issues.push(`${file}: symlink`);continue;}
  let content=readFileSync(file,'utf8');
  // Exact synthetic SSRF fixture, not a credential exemption for other tests.
  if(file === 'test/validate.test.ts') content=content.replace('https://' + 'user:pw@' + 'example.com','synthetic-invalid-url');
  if(patterns.some(pattern=>pattern.test(content)))issues.push(`${file}: potential credential`);
}
if(issues.length){console.error(issues.join('\n'));process.exit(1);}
console.log(`Publication scan passed for ${files.length} files. Manually review confidential content and the staged diff too.`);
