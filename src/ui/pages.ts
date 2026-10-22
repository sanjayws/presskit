import type { InlineManifest } from "../images/inline";
import { selectedChannels, MAX_CHANNELS } from "../style/channels";
import type { SavedSourceDocument } from "../grounding/uploads";
/**
 * Server-rendered UI. Left sidebar (Campaigns -> History) wraps every screen;
 * the main pane holds the campaign form, angle picker, or the result screen.
 * The result screen is the product surface: an inline WYSIWYG editor, a copy
 * button on every output, a zoomable featured PNG, and a download-all zip.
 */
import type { Article, Campaign, Run, RunHistory, Topic } from "../db/repos";
import type { ImageJob } from "../db/image-jobs";
import {
  PERSONAS,
  TONES,
  TEMPERATURE_PRESETS,
  IMAGE_STYLES,
  CTAS,
  CTA_ACTIONS,
  BIAS_LEVELS,
  ARTICLE_TYPES,
  OUTPUT_FORMATS,
  CHANNEL_PROFILES,
  channelProfile,
  isCampaignChannel,
  isOutputFormat,
  type OutputFormat,
  type Option,
} from "../style/engine";
import { isRichFormat } from "../content/render";
import { STYLE } from "./styles";
import { countWords } from "../style/engine";
import { progressFor, RUN_PROGRESS_SCRIPT } from "./run-progress";
import { currentImageVersion, imageStatus, type ImageVersion } from "../images/history";
import { IMAGE_PROGRESS_SCRIPT } from "./image-progress";
import type { SourceResult } from "../grounding/report";
import { evidenceFindings, type EditorialCheckpoint } from "../editorial/review";
import { HISTORY_SCRIPT } from "./history";
import type { ReadinessReport } from "../grounding/readiness";
import { runFailure } from "./run-failure";

/** Info icon with a hover/focus tooltip. */
function hint(text: string): string {
  return `<span class="hint" tabindex="0" role="note" aria-label="${escAttr(text)}">i<span class="tip">${esc(text)}</span></span>`;
}

/** A form label with an attached tooltip. */
function lbl(text: string, tip: string, controlId?: string): string {
  return `<label${controlId ? ` for="${escAttr(controlId)}"` : ""}>${esc(text)}${hint(tip)}</label>`;
}

function escAttr(s: string): string {
  return esc(s);
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface Nav {
  email: string;
  history: RunHistory[];
  nonce: string;
}

// Brand mark: a spark on a gradient tile. Reused as the favicon.
const LOGO_SVG = `<svg class="logo" width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="36" height="36" rx="8" fill="#087f82"/><path d="M11 9h9a7 7 0 0 1 0 14h-5v5h-4V9zm4 4v6h5a3 3 0 0 0 0-6h-5z" fill="#fff"/></svg>`;
const FAVICON_SVG = LOGO_SVG;
const FAVICON = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);

const STATE_LABEL: Record<string, string> = {
  drafting_topics: "Researching your idea and drafting angles…",
  awaiting_topic_selection: "Pick an angle to continue",
  writing: "Writing article…",
  styling: "Reviewing and improving the draft…",
  asset_gen: "Rendering featured image…",
  ready: "Ready for review",
  failed: "Needs attention",
  needs_input: "Add the missing details",
};

const SHORT_STATE: Record<string, string> = {
  drafting_topics: "drafting",
  awaiting_topic_selection: "select",
  writing: "writing",
  styling: "reviewing",
  asset_gen: "imaging",
  ready: "ready",
  failed: "failed",
  needs_input: "needs input",
};


// No inline event handlers anywhere: everything is delegated here so a strict
// CSP (script-src 'nonce-...') can forbid inline/injected script.
const SCRIPT = `
function toast(t){var e=document.getElementById('toast');e.textContent=t;e.classList.add('show');setTimeout(function(){e.classList.remove('show')},1400)}
async function clip(t){try{await navigator.clipboard.writeText(t);toast('Copied')}catch(e){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('Copied')}}
function readVal(el){if(!el)return '';if(el.value!=null&&('INPUT'===el.tagName||'TEXTAREA'===el.tagName))return el.value;if(el.dataset.raw!=null)return el.dataset.raw;return el.textContent;}
function copyVal(id){var el=document.getElementById(id);if(el)clip(readVal(el));}
async function portableCopy(copy){for(var img of copy.querySelectorAll('img[src]')){var url=new URL(img.getAttribute('src'),location.origin);if(url.origin!==location.origin||!/^\\/articles\\/[a-zA-Z0-9_-]+\\/inline-images\\/[1-3]\\.(?:png|svg)$/.test(url.pathname))continue;var response=await fetch(url.pathname);if(!response.ok)throw Error('Image copy failed');var blob=await response.blob();if(blob.size>6000000||!['image/png','image/svg+xml'].includes(blob.type))throw Error('Image unavailable');img.src=await new Promise(function(resolve,reject){var reader=new FileReader();reader.onload=function(){resolve(reader.result);};reader.onerror=reject;reader.readAsDataURL(blob);});}return copy.innerHTML.trim();}
async function copyHtml(id){var el=document.getElementById(id);if(el)try{await clip(await portableCopy(el.cloneNode(true)));}catch(e){toast('Use Download all to include the images.');}}
/* Copy the article "as-is": rich text (keeps formatting when pasted into a
   visual editor / Docs / Word) plus a plain-text fallback. */
async function copyRich(id,plainOnly){var el=document.getElementById(id);if(!el)return;
 var copy=el.cloneNode(true);var card=el.closest('[data-format]');if(card&&card.dataset.format==='linkedin'){copy.querySelectorAll('a[href]').forEach(function(a){if(a.textContent!==a.getAttribute('href'))a.append(' ('+a.getAttribute('href')+')');});}
 var html;try{html=plainOnly?'':await portableCopy(copy);}catch(e){toast('Use Download all to include the images.');return;}var text=(el.innerText||el.textContent||'').trim();if(card&&card.dataset.format==='linkedin'){copy.removeAttribute('id');copy.removeAttribute('contenteditable');copy.style.cssText='position:fixed;left:-10000px;top:0;width:600px';document.body.appendChild(copy);text=copy.innerText.trim();copy.remove();}
 if(plainOnly){await clip(text);return;}
 try{if(window.ClipboardItem){await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([text],{type:'text/plain'})})]);toast('Copied');return;}}catch(e){}
 clip(text);}

/* --- WYSIWYG: snapshot of the last-saved state, for Cancel/revert --- */
var SNAP={};
/* Field name must match the server contract exactly: body_html, not body. */
function fieldsOf(card){var rte=card.querySelector('.rte');return {body_html:rte?rte.innerHTML:'',title:val(card,'title'),slug:val(card,'slug'),meta_desc:val(card,'meta'),excerpt:val(card,'excerpt'),key_phrases:val(card,'kp')};}
function val(card,f){var el=card.querySelector('[data-field="'+f+'"]');return el?el.value:'';}
function setVal(card,f,v){var el=card.querySelector('[data-field="'+f+'"]');if(el)el.value=v;}
/* Mirror the edited title into the read-only headline block at the top. */
function syncTitle(card){var v=card.querySelector('[data-title-view]');if(v&&card.querySelector('[data-field="title"]'))v.textContent=val(card,'title');}
function snapshot(card){SNAP[card.id]=fieldsOf(card);}
function markClean(card){card.classList.remove('dirty');}
function markDirty(card){card.classList.add('dirty');}
/* Apply the server's canonical saved article back into the editor. */
function applyCanonical(card,art){if(!art)return;
 if(typeof art.body_html==='string'){var _r=card.querySelector('.rte');if(_r)_r.innerHTML=art.body_html;}
 if(typeof art.title==='string'){setVal(card,'title',art.title);syncTitle(card);}
 if(typeof art.slug==='string')setVal(card,'slug',art.slug);
 if(typeof art.meta_desc==='string')setVal(card,'meta',art.meta_desc);
 if(typeof art.excerpt==='string')setVal(card,'excerpt',art.excerpt);
 if(Array.isArray(art.key_phrases)){setVal(card,'kp',art.key_phrases.join(', '));
  /* keep the read-only Yoast focus keyphrase in sync: always the first phrase */
  var fk=card.querySelector('input[id^="fkp_"]');if(fk)fk.value=art.key_phrases[0]||'';}}
document.addEventListener('DOMContentLoaded',function(){var cs=document.querySelectorAll('.artcard');for(var i=0;i<cs.length;i++){snapshot(cs[i]);syncTitle(cs[i]);}});
document.addEventListener('input',function(e){var card=e.target.closest('.artcard');if(card&&(e.target.classList.contains('rte')||e.target.dataset.field)){markDirty(card);if(e.target.dataset.field==='title')syncTitle(card);}});

async function saveArticle(btn){var card=document.getElementById('card_'+btn.getAttribute('data-save'));if(!card)return;
 var p=fieldsOf(card);var old=btn.textContent;btn.disabled=true;btn.textContent='Saving…';
 try{var r=await fetch('/articles/'+btn.getAttribute('data-save'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});
  if(!r.ok)throw 0;var d=await r.json().catch(function(){return null;});
  if(d&&d.article)applyCanonical(card,d.article);
  snapshot(card);markClean(card);var status=card.querySelector('[data-save-status]');if(status)status.textContent=d&&d.warnings&&d.warnings.length?'Saved. '+d.warnings.join(' '):'Saved. Your edits have not been reviewed by the editor.';toast('Saved');}
 catch(e){toast('Save failed');}
 btn.disabled=false;btn.textContent=old;}
function cancelEdit(btn){var card=document.getElementById('card_'+btn.getAttribute('data-cancel'));if(!card)return;
 var s=SNAP[card.id];if(!s)return;
 var _r=card.querySelector('.rte');if(_r)_r.innerHTML=s.body_html;setVal(card,'title',s.title);setVal(card,'slug',s.slug);setVal(card,'meta',s.meta_desc);setVal(card,'excerpt',s.excerpt);setVal(card,'kp',s.key_phrases);
 syncTitle(card);markClean(card);toast('Changes discarded');}

${IMAGE_PROGRESS_SCRIPT}

/* --- image lightbox with click-to-zoom --- */
var lbReturnFocus=null;
function openLb(src){var lb=document.getElementById('lb');lbReturnFocus=document.activeElement;document.getElementById('lbimg').src=src;lb.classList.remove('zoomed');lb.classList.add('open');lb.setAttribute('aria-hidden','false');lb.querySelector('button').focus();}
function closeLb(){var lb=document.getElementById('lb');if(!lb.classList.contains('open'))return;lb.classList.remove('open','zoomed');lb.setAttribute('aria-hidden','true');document.getElementById('lbimg').src='';if(lbReturnFocus)lbReturnFocus.focus();}
document.addEventListener('keydown',function(e){var lb=document.getElementById('lb');if(e.key==='Tab'&&lb.classList.contains('open')){e.preventDefault();lb.querySelector('button').focus();}});

document.addEventListener('click',function(e){
 var c=e.target.closest('[data-copy]');if(c){copyVal(c.getAttribute('data-copy'));return;}
 var cp=e.target.closest('[data-copy-plain]');if(cp){copyRich(cp.dataset.copyPlain,true);return;}
 var ch=e.target.closest('[data-copy-html]');if(ch){copyHtml(ch.getAttribute('data-copy-html'));return;}
 var cr=e.target.closest('[data-copy-rich]');if(cr){copyRich(cr.getAttribute('data-copy-rich'));return;}
 var cmd=e.target.closest('[data-cmd]');if(cmd){e.preventDefault();var k=cmd.getAttribute('data-cmd');
  if(k==='createLink'){var u=prompt('Link URL (https://...)');if(u)document.execCommand('createLink',false,u);}
  else if(k==='formatBlock'){document.execCommand('formatBlock',false,cmd.getAttribute('data-val'));}
  else document.execCommand(k,false,null);
  var cd=cmd.closest('.artcard');if(cd)markDirty(cd);return;}
 var sv=e.target.closest('[data-save]');if(sv){saveArticle(sv);return;}
 var cn=e.target.closest('[data-cancel]');if(cn){cancelEdit(cn);return;}
 var im=e.target.closest('[data-image-mode]');if(im){requestImage(im);return;}
 var z=e.target.closest('[data-zoom]');if(z){openLb(z.getAttribute('data-zoom'));return;}
 if(e.target.id==='lbimg'){document.getElementById('lb').classList.toggle('zoomed');return;}
 if(e.target.id==='lb'||e.target.closest('[data-lb-close]')){closeLb();return;}
 var t=e.target.closest('[data-action="toggle-side"]');if(t){var s=document.querySelector('.side');if(s){s.classList.toggle('open');t.setAttribute('aria-expanded',String(s.classList.contains('open')));}}
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeLb();var side=document.querySelector('.side');if(side)side.classList.remove('open');var menu=document.querySelector('[data-action="toggle-side"]');if(menu)menu.setAttribute('aria-expanded','false');}});
document.addEventListener('submit',function(e){var f=e.target.closest('form[data-confirm]');if(f&&!confirm(f.getAttribute('data-confirm')))e.preventDefault();});
window.addEventListener('beforeunload',function(e){if(document.querySelector('.artcard.dirty')){e.preventDefault();e.returnValue='';}});
var channelProfiles=${JSON.stringify(CHANNEL_PROFILES)};
function updateChannel(){var field=document.getElementById('output_format');var spec=document.querySelector('[data-channel-spec]');if(field&&spec)spec.textContent=channelProfiles[field.value].summary;if(field)document.querySelectorAll('[name=output_formats]').forEach(function(box){if(box.disabled&&box.value!==field.value)box.checked=false;box.disabled=box.value===field.value;if(box.disabled)box.checked=true;});}
document.addEventListener('change',updateChannel);updateChannel();
function updateBrief(){var form=document.querySelector('[data-brief-form]');if(!form)return;
 form.querySelectorAll('[data-summary]').forEach(function(el){var name=el.dataset.summary;var field=form.elements.namedItem(name);
  if(name==='sources'){var urls=form.elements.namedItem('urls').value.trim().split(/\\r?\\n/).filter(Boolean);var upload=form.elements.namedItem('upload');el.textContent=urls.length+(upload.files.length?1:0)+Number(form.dataset.savedDocuments||0)+' provided';}
  else if(name==='max_words')el.textContent=Math.min(Number(field.value),channelProfiles[form.elements.namedItem('output_format').value].maxWords)+' words';
  else if(name==='article_type'&&['email','chat','linkedin','social'].includes(form.elements.namedItem('output_format').value)){var destination=form.elements.namedItem('output_format');el.textContent=destination.options[destination.selectedIndex].text;}
  else if(field)el.textContent=field.options[field.selectedIndex].text;});}
document.addEventListener('input',updateBrief);document.addEventListener('change',updateBrief);updateBrief();
async function briefError(form){var channels=new Set([form.elements.namedItem('output_format').value,...Array.from(form.querySelectorAll('[name=output_formats]:checked')).map(function(el){return el.value;})]);if(channels.size>4)return 'Choose up to 4 destinations including the primary one.';if(!form.hasAttribute('data-brief-form'))return '';
 var urls=form.elements.namedItem('urls').value.trim().split(/\\r?\\n/).map(function(v){return v.trim();}).filter(Boolean);var upload=form.elements.namedItem('upload').files[0];
 if(form.elements.namedItem('idea').value.length>12000)return 'Keep the brief to 12,000 characters or fewer.';
 if(form.elements.namedItem('include_ideas').value.length>6000||form.elements.namedItem('exclude_ideas').value.length>6000)return 'Keep Ideas to include and Topics to avoid to 6,000 characters each.';
 if(!form.dataset.autoPlanning&&form.elements.namedItem('article_type').value!=='fiction'&&!urls.length&&!upload&&!Number(form.dataset.savedDocuments||0))return 'Add at least one source URL or a readable supporting document. Saved files marked unreadable cannot be used.';
 if(urls.length>10)return 'Use up to 10 source URLs.';
 for(var i=0;i<urls.length;i++){try{var u=new URL(urls[i]);if(!/^https?:$/.test(u.protocol))throw 0;}catch(e){return 'Check source URL '+(i+1)+'. Use a complete https:// address.';}}
 if(upload&&(upload.size>10000000||!/\\.(txt|html?|pdf|docx?|xlsx?|pptx?|csv|md)$/i.test(upload.name)))return 'Upload a PDF, Word, Excel, PowerPoint, CSV or text file of up to 10 MB.';
 if(upload&&/\\.(txt|csv|md)$/i.test(upload.name)){var text;try{text=await upload.text();}catch(e){return 'This file could not be read. Select it again.';}if(!/<\\/?[a-z][\\s\\S]*>/i.test(text)&&text.trim().length<40)return 'This document needs at least 40 readable characters. Upload a document with supporting content.';if(!/<\\/?[a-z][\\s\\S]*>/i.test(text)&&text.length>60000)return 'This document exceeds 60,000 characters. Upload only the relevant content.';}
 return '';}
document.addEventListener('submit',async function(e){var form=e.target;if(!form.matches('[data-flow-form]'))return;e.preventDefault();if(form.dataset.busy)return;form.dataset.busy='checking';
 var errorBox=form.querySelector('[data-form-error]');var issue=await briefError(form);errorBox.textContent=issue;if(issue){delete form.dataset.busy;errorBox.focus();return;}
 var submitter=e.submitter;var target=submitter&&submitter.hasAttribute('formaction')?submitter.formAction:form.action;var data=new FormData(form);
 var buttons=Array.from(form.querySelectorAll('button[type="submit"]'));form.dataset.busy='true';buttons.forEach(function(b){b.disabled=true;});var original=submitter?submitter.textContent:'';if(submitter)submitter.textContent='Working…';
 try{var response=await fetch(target,{method:'POST',body:data});if(response.ok&&response.redirected){location.assign(response.url);return;}
  var message=response.status===401?'Your session expired. Sign in again to continue.':(await response.text()).slice(0,600);
  errorBox.textContent=message&&message.indexOf('<')<0?message:'We could not complete this step. Please try again.';errorBox.focus();}
 catch(error){errorBox.textContent='Connection interrupted. Your brief is still here; try again.';errorBox.focus();}
 delete form.dataset.busy;buttons.forEach(function(b){b.disabled=false;});if(submitter)submitter.textContent=original;});
document.addEventListener('click',async function(e){var button=e.target.closest('[data-auto-decide]');if(!button)return;var form=button.closest('form');var status=form.querySelector('[data-auto-status]');if(button.disabled)return;
 form.dataset.autoPlanning='true';var issue=await briefError(form);delete form.dataset.autoPlanning;if(!form.elements.namedItem('idea').value.trim())issue='Describe the content you want first.';if(issue){status.textContent=issue;return;}
 var data=new FormData(form);var snapshot=JSON.stringify(Array.from(data.entries()).map(function(p){return [p[0],typeof p[1]==='string'?p[1]:(p[1].size?[p[1].name,p[1].size,p[1].lastModified]:null)];}));
 button.disabled=true;status.textContent='Reading your inputs and sources in the background… You can keep reviewing this form.';
 try{var start=await fetch('/brief/auto-decide',{method:'POST',body:data});if(!start.ok)throw Error((await start.text()).slice(0,500));var job=await start.json();
 var result;for(var i=0;i<450;i++){await new Promise(function(r){setTimeout(r,2000);});var check=await fetch('/brief/auto-decide/'+encodeURIComponent(job.id),{cache:'no-store'});if(!check.ok)throw Error('Could not check Auto decide. Your brief is kept. Try again.');result=await check.json();if(result.state==='failed')throw Error(result.error);if(result.state==='ready')break;}
 if(!result||result.state!=='ready')throw Error('Auto decide is still working. Your brief is kept. Please return later or select settings manually.');
 var current=JSON.stringify(Array.from(new FormData(form).entries()).map(function(p){return [p[0],typeof p[1]==='string'?p[1]:(p[1].size?[p[1].name,p[1].size,p[1].lastModified]:null)];}));if(current!==snapshot)throw Error('Your inputs changed while AI was reading. Run Auto decide again to get suggestions for your latest brief.');
 var s=result.suggestions;['article_type','output_format','persona','tone','temperature','max_words','image_style','inline_image_count','image_brief'].forEach(function(name){var field=form.elements.namedItem(name);if(field&&s[name]!==undefined){field.value=String(s[name]);field.classList.add('ai-suggested');var section=field.closest('details');if(section)section.open=true;}});
 form.querySelectorAll('[name=output_formats]').forEach(function(box){box.disabled=false;box.checked=s.output_formats.includes(box.value);});updateChannel();updateBrief();var details=form.querySelector('[name=output_formats]').closest('details');if(details)details.open=s.output_formats.length>1;
 status.textContent='Suggested settings applied — review them before submitting. '+s.reason+(result.warnings.length?' '+result.warnings.join(' '):'');form.querySelector('#article_type').focus();
 }catch(error){status.textContent=error.message||'Auto decide could not finish. Your brief is kept.';}finally{button.disabled=false;}});
${RUN_PROGRESS_SCRIPT}
`;

function sidebar(nav: Nav, activeRunId?: string): string {
  const items =
    nav.history.length === 0
      ? `<div class="histempty">No runs yet.</div>`
      : nav.history
          .map((h) => {
            const active = h.id === activeRunId ? " active" : "";
            const sClass =
              h.state === "ready" ? " ready" : h.state === "failed" ? " failed" : "";
            const label = h.idea.trim() || "Untitled campaign";
            return `<a class="histitem${active}" href="/runs/${esc(h.id)}" title="${escAttr(label)}"${active ? ' aria-current="page"' : ""}>
<span class="t">${esc(label)}</span>
<span class="s${sClass}">${esc(SHORT_STATE[h.state] ?? h.state)}${h.history_group ? ` · ${esc(h.history_group)}` : ""}</span></a>`;
          })
          .join("");

  return `<aside class="side" id="workspace-nav" aria-label="Workspace navigation">
  <div class="brand">${LOGO_SVG}<span><strong>Presskit</strong><small>CONTENT STUDIO</small></span></div>
  <a class="navnew" href="/">+ New content</a>
  <a class="navhelp" href="/help">Help &amp; writing guide</a>
  <div class="navgroup" title="Your active runs, newest first.">History <a class="history-manage" href="/history">Manage</a></div>
  <div class="hist">${items}</div>
  <div class="side-foot"><span class="side-email" title="${escAttr(nav.email)}">${esc(nav.email)}</span><a href="/auth/logout">Sign out</a></div>
</aside>`;
}

/** Full-page shell: sidebar + main content. */
export function shell(
  nav: Nav,
  title: string,
  bodyInner: string,
  activeRunId?: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${FAVICON}">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><a class="skip-link" href="#content">Skip to content</a><div class="app">
${sidebar(nav, activeRunId)}
<main class="main" id="content"><header class="topbar"><div class="row"><button class="btn menu" type="button" data-action="toggle-side" aria-expanded="false" aria-controls="workspace-nav">☰ Menu</button><strong>Content workspace</strong></div><a class="help-link" href="/help">How Presskit works ↗</a></header><div class="wrap">
${bodyInner}
</div></main>
</div>
<div id="lb" class="lb" role="dialog" aria-modal="true" aria-label="Featured visual" aria-hidden="true"><button class="lb-x" type="button" data-lb-close aria-label="Close preview">✕</button><img id="lbimg" alt="zoomed featured image"><div class="lb-hint">Click image for full size · Esc to close</div></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script nonce="${esc(nav.nonce)}">${SCRIPT}\n${HISTORY_SCRIPT}</script></body></html>`;
}

function optionSelect(name: string, list: Option[], selected: string): string {
  const opts = list
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === selected ? " selected" : ""}>${esc(
          o.label,
        )}</option>`,
    )
    .join("");
  return `<select id="${name}" name="${name}">${opts}</select>`;
}

function ctaSelect(selected: string): string {
  const opts = CTAS.map(
    (o) =>
      `<option value="${esc(o.value)}"${o.value === selected ? " selected" : ""}>${esc(
        o.label,
      )}</option>`,
  ).join("");
  return `<select id="cta" name="cta">${opts}</select>`;
}

function voiceSelect(selected: string): string {
  const opts = [
    ["ms-en", "Malaysian English"],
    ["en-gb", "British English"],
    ["en-us", "US English"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`,
    )
    .join("");
  return `<select id="voice_profile" name="voice_profile">${opts}</select>`;
}

/** Shared campaign form for create (no campaign) and edit (existing campaign). */
function campaignFormBody(c?: Campaign, savedDocuments: SavedSourceDocument[] = []): string {
  const editing = !!c;
  const action = editing ? `/campaigns/${esc(c.id)}` : "/campaigns";
  const idea = c ? esc(c.idea) : "";
  const urls = c
    ? esc(
        (() => {
          try {
            return (JSON.parse(c.grounding_refs) as { source: string }[])
              .map((r) => r.source)
              .join("\n");
          } catch {
            return "";
          }
        })(),
      )
    : "";
  const persona = c?.persona || "professional";
  const tone = c?.tone || "professional";
  const temperature = c ? String(c.temperature) : "0.6";
  const imageStyle = c?.image_style || "editorial";
  const voice = c?.voice_profile || "ms-en";
  const maxWords = c ? c.max_words : 800;
  const signature = c ? esc(c.signature) : "";
  const imageBrief = c ? esc(c.image_brief) : "";
  const cta = c?.cta || "";
  const ctaAction = c?.cta_action || "";
  const ctaTarget = c ? esc(c.cta_target) : "";
  const includeIdeas = c ? esc(c.include_ideas) : "";
  const excludeIdeas = c ? esc(c.exclude_ideas) : "";
  const biasLevel = c ? String(c.bias_level) : "3";
  const articleType = c?.article_type || "article";
  const referenceLinks = c
    ? esc(
        (() => {
          try {
            return (JSON.parse(c.reference_links) as { url: string; label: string }[])
              .map((r) => (r.label ? `${r.url} | ${r.label}` : r.url))
              .join("\n");
          } catch {
            return "";
          }
        })(),
      )
    : "";

  return `
<form method="post" action="${action}" enctype="multipart/form-data" data-flow-form data-brief-form data-saved-documents="${savedDocuments.filter((doc) => doc.status === "loaded" || doc.status === "pending").length}">
${c ? `<input type="hidden" name="campaign_id" value="${escAttr(c.id)}">` : ""}
<div class="form-layout">
<div class="form-main">
<section class="card form-section">
  <div class="section-header"><span class="section-number">01</span><div><h2>Content brief</h2><p>Tell us who it is for, what matters, and where it will appear.</p></div></div>
  ${lbl("What should this content achieve?", "Describe the subject, audience, and the decision or task you want to help with.", "idea")}
  <textarea id="idea" name="idea" required maxlength="12000" rows="4" placeholder="e.g. Help Malaysian SME owners understand when to move from a legacy phone system to cloud PBX. Focus on migration, support and cost.">${idea}</textarea>
  <p class="field-help">Maximum 12,000 characters. Include your audience, goal, must-cover points and required order. <a href="/help#brief">See a brief example</a>.</p>
  <div class="auto-decide-panel"><button type="button" class="btn primary auto-decide" data-auto-decide>✦ Auto decide</button><p class="field-help">Let AI read your brief and sources, then fill suitable settings. Review everything before submitting. Uses AI credits.</p><p data-auto-status role="status" aria-live="polite"></p></div>
  ${lbl("Primary destination", "Sets the writing length, formatting and image shape. You can confirm it after research.", "output_format")}
  ${optionSelect("output_format", OUTPUT_FORMATS, c?.output_format || "html")}
  ${extraChannels(c?.output_format || "html", c?.output_formats)}
  <p class="channel-spec" data-channel-spec aria-live="polite">${esc(channelProfile(c?.output_format).summary)}</p>
  ${lbl("Source URLs", "Use public pages you trust. Source material provides facts; it does not publish anything.", "urls")}
  <textarea id="urls" name="urls" rows="3" placeholder="https://yourcompany.com/product&#10;https://yourcompany.com/resources">${urls}</textarea>
  <p class="field-help">One URL per line, up to 10. Include product details, documentation or supporting evidence.</p>
  ${savedDocuments.length ? `<div class="source-summary"><h3>Saved documents</h3><p>Saved files stay attached. Ready files will be reused; you do not need to upload them again. Unreadable files need a readable replacement or another source.</p><ul>${savedDocuments.map((doc) => `<li>${esc(doc.filename)} — ${doc.status === "loaded" ? "Ready to use" : doc.status === "pending" ? "Waiting for extraction" : "Could not be read; check the source report"}${doc.docId && doc.status === "loaded" ? ` · <a class="source-download" href="/sources/${encodeURIComponent(doc.docId)}/markdown">View extracted text</a>` : ""}</li>`).join("")}</ul></div>` : ""}
  ${lbl("Supporting document", "PDF, Word, Excel, PowerPoint, CSV or text, up to 10 MB. At least one source URL or document is required.", "upload")}
  <input id="upload" type="file" name="upload" accept=".txt,.html,.htm,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.md">
  <p class="field-help">One new file per submission, up to 10 MB (10,000,000 bytes). Extracted text must contain at least 40 readable characters, up to 60,000 characters per document (roughly 10,000 English words). There is no fixed page limit; a file under 10 MB can still contain too much text. New uploads are added to your saved documents.</p>
  <p class="field-help">Across all sources, readiness checks and writing use up to 60,000 characters of evidence. Larger collections use excerpts selected for relevance to your brief; details outside those excerpts may be missed. Upload the relevant pages, slides or sheets. <a href="/help#source-limits">See all input limits</a>.</p>
</section>
<details class="fold"><summary>Writing preferences <span class="summary-note">Structure, tone &amp; length</span></summary><p>Defaults work for most briefs. The destination applies a shorter limit where needed.</p>
  <div class="row"><div>${lbl("Article type", "The structure to research and write: comparison, how-to, review or an evergreen article.", "article_type")}${optionSelect("article_type", ARTICLE_TYPES, articleType)}</div>
  <div>${lbl("Tone", "The mood of the writing. Professional is a reliable starting point.", "tone")}${optionSelect("tone", TONES, tone)}</div></div>
  <div class="row"><div>${lbl("Language style", "Regional spelling and usage throughout the article.", "voice_profile")}${voiceSelect(voice)}</div>
  <div>${lbl("Maximum words", "Article cap: 200 to 2,000 words. Channel caps: LinkedIn/Facebook 220, Email 350, Chat 120; the lower limit applies.", "max_words")}<input id="max_words" type="number" name="max_words" value="${maxWords}" min="200" max="2000" step="1" required></div></div>
  <details class="fold"><summary>Author voice &amp; phrasing <span class="summary-note">Optional</span></summary>
  <div class="row"><div>${lbl("Write as", "Sets the perspective and phrasing; never invents personal experience or credentials.", "persona")}${optionSelect("persona", PERSONAS, persona)}</div>
  <div>${lbl("Creativity", "Sets how restrained or varied the phrasing should be. Evidence requirements always stay the same.", "temperature")}${optionSelect("temperature", TEMPERATURE_PRESETS, temperature)}</div></div>
  ${lbl("Signature", "Optional sign-off. Only enter an identity you are authorised to use.", "signature")}
  <input id="signature" name="signature" maxlength="160" value="${signature}" placeholder="By your name, your role">
  </details>
</details>
<details class="fold"><summary>Visual preferences <span class="summary-note">Style &amp; creative direction</span></summary><p>The destination sets the image shape. Keep important information in the written content too.</p>
  ${lbl("Visual style", "Choose the look. Bold editorial starts with a memorable idea; diagrams are available when the explanation needs one.", "image_style")}
  ${optionSelect("image_style", IMAGE_STYLES, imageStyle)}
  ${lbl("Inline illustrations", "Additional images placed inside long-form outputs, besides the hero. Social/chat use the hero only.", "inline_image_count")}
  <select id="inline_image_count" name="inline_image_count">${[0, 1, 2, 3].map((n) => `<option value="${n}"${n === (c?.inline_image_count || 0) ? " selected" : ""}>${n === 0 ? "Hero image only" : `${n} inline ${n === 1 ? "image" : "images"} + hero`}</option>`).join("")}</select><p class="field-help">Supported for WordPress, email, Word and Markdown. AI chooses SVG diagrams for suitable WordPress/Markdown passages and PNG scenes otherwise. Email/Word use PNG for compatibility. Visuals are inserted automatically and use AI credits; SVGs do not require an image-generation call. Fiction can use invented characters and scenes; factual writing uses sourced or clearly illustrative situations.</p>
  ${lbl("Creative direction", "Describe palette, audience, layout or visual emphasis. Claims and statistics must come from the article, not this brief.", "image_brief")}
  <textarea id="image_brief" name="image_brief" maxlength="1000" placeholder="e.g. A dramatic editorial still life about a carefully planned transition. Sculpted paper, cobalt and warm orange, strong directional light. One focal subject; no text or generic cloud icons.">${imageBrief}</textarea>
  <p class="field-help">Optional. Add brand colours, a mood, materials or things to avoid. Claude compares three concepts and selects one for Sunburst to render. <a href="/help#images">About images</a>.</p>
</details>
<details class="fold"><summary>Editorial boundaries <span class="summary-note">Optional</span></summary>
<p>Guide emphasis while keeping factual claims supported by your sources.</p>
${lbl("Ideas to include", "Maximum 6,000 characters. Points to cover where your sources support them.", "include_ideas")}
<textarea id="include_ideas" name="include_ideas" maxlength="6000" placeholder="e.g. Migration planning, local support, recurring costs">${includeIdeas}</textarea>
${lbl("Topics to avoid", "Maximum 6,000 characters. Optional exclusions; do not conceal material limitations.", "exclude_ideas")}
<textarea id="exclude_ideas" name="exclude_ideas" maxlength="6000" placeholder="e.g. Unannounced products, confidential customer details">${excludeIdeas}</textarea>
${lbl("Editorial stance", "Choose neutral or promotional emphasis. Evidence, honest comparisons and material caveats are required at every level.", "bias_level")}
${optionSelect("bias_level", BIAS_LEVELS, biasLevel)}
</details>
<details class="fold"><summary>Links &amp; call to action <span class="summary-note">Optional</span></summary>
${lbl("Reference links", "Links for the published article. Format: URL | label, one per line.", "reference_links")}
<textarea id="reference_links" name="reference_links" placeholder="https://yourcompany.com/pricing | View pricing">${referenceLinks}</textarea>
<p class="field-help">These links are read as research sources when accessible. Articles include them; messages use relevant inline links without a further-reading list. Failed sources are listed before you choose an angle.</p>
<div class="row"><div>${lbl("Call to action", "A short block near the end of the article.", "cta")}${ctaSelect(cta)}</div>
<div>${lbl("Link action", "Select how readers can respond.", "cta_action")}${optionSelect("cta_action", CTA_ACTIONS, ctaAction)}</div></div>
${lbl("Destination", "Use a website URL, email address or international phone number that matches the link action.", "cta_target")}
<input id="cta_target" name="cta_target" maxlength="400" value="${ctaTarget}" placeholder="https://yourcompany.com/contact">
<p class="field-help">Check the CTA wording: offers such as a free trial must be something your business actually provides.</p>
</details>
<div class="form-error" data-form-error role="alert" tabindex="-1"></div>
<div class="submit-bar"><button class="primary" type="submit">${editing ? "Save & check brief" : "Check brief & sources"} <span aria-hidden="true">→</span></button><span class="submit-note">First: check the evidence. If details are missing, get specific next steps before writing.</span></div>
</div>
<aside class="brief-aside" aria-label="Brief review">
<div class="card"><div class="eyebrow">From brief to ready</div><h2>One brief. A complete workflow.</h2>
<ol class="workflow-list"><li><strong>Check readiness</strong><span>Read your sources, flag missing facts, then suggest three angles.</span></li><li><strong>You choose</strong><span>Confirm the angle and destination.</span></li><li><strong>Write, review, improve</strong><span>Check evidence, every requested point and channel fit. Revise up to three times.</span></li><li><strong>Create &amp; export</strong><span>Get a matching visual and files for your channel.</span></li></ol>
<a href="/help">Explore the guide →</a></div>
<div class="card"><div class="eyebrow">Brief at a glance</div><div class="review-summary">
<div><span>Structure</span><strong data-summary="article_type"></strong></div>
<div><span>Voice</span><strong data-summary="tone"></strong></div>
<div><span>Length</span><strong data-summary="max_words"></strong></div>
<div><span>Sources</span><strong data-summary="sources"></strong></div>
</div><p class="field-help">Check names, figures and visual labels against your original sources before publication.</p></div>
</aside>
</div>
</form>`;
}

export function dashboard(nav: Nav): string {
  const body = `
${stepper(1)}
<div class="page-heading"><div class="eyebrow">Create with confidence</div><h1>Turn your expertise into useful content.</h1>
<p>Choose a destination, add your brief and sources, then pick an angle. Presskit drafts, reviews and improves the content before creating a matching visual.</p></div>
${campaignFormBody()}`;
  return shell(nav, "Presskit", body);
}

export function editCampaign(nav: Nav, c: Campaign, savedDocuments: SavedSourceDocument[] = []): string {
  const body = `
<div class="page-heading"><div class="eyebrow">Refine your direction</div><h1>Edit campaign</h1>
<p>Update the brief to start a new research run. Existing articles remain in your history.</p></div>
${campaignFormBody(c, savedDocuments)}`;
  return shell(nav, "Edit campaign", body);
}

/** Edit / delete controls for a campaign, shown on run pages. */
function campaignActions(campaignId: string): string {
  return `<div class="row" style="margin:8px 0 4px">
<a class="btn" href="/campaigns/${esc(campaignId)}/edit" title="Refine the brief and start a fresh run.">Edit brief</a>
<form method="post" action="/campaigns/${esc(campaignId)}/delete" data-confirm="Delete this campaign and all its runs? This cannot be undone." style="margin:0">
<button class="btn" type="submit" style="color:var(--err);border-color:#fecdd3" title="Permanently delete this campaign, its runs, articles and images.">Delete</button></form>
</div>`;
}

export function sourceSummary(sources: SourceResult[]): string {
  if (!sources.length) return "";
  const failed = sources.filter((source) => source.status === "unavailable").length;
  return `<details class="fold source-summary"${failed ? " open" : ""}><summary>Research sources <span class="summary-note">${sources.filter((source) => source.status === "loaded").length} read${failed ? ` · ${failed} unavailable` : ""}</span></summary><ul>${sources.map((source) => `<li><strong>${esc(source.source)}</strong>: ${esc(source.message)}${source.status === "loaded" && source.docId ? ` <a class="source-download" href="/sources/${encodeURIComponent(source.docId)}/markdown" download>Download source (.md)</a>` : ""}</li>`).join("")}</ul><p>Only successfully read sources supply factual evidence. Download the extracted Markdown to inspect what was read. Upload a readable copy of an unavailable source if its information is essential.</p></details>`;
}

function editorialSummary(checkpoint: EditorialCheckpoint, articleId?: string, article?: Article): string {
  const state = checkpoint.state;
  const label = state === "accepted" ? "Exceptions accepted by you — automated review did not pass" : state === "passed" ? "Generated draft passed automated review" : state === "needs_attention" ? "Editorial review needs your attention" : state === "revise" ? "Revising the draft" : "Checking the complete draft";
  const issues = [...new Set([...(checkpoint.report?.issues ?? []), ...(checkpoint.report?.checks.factual_accuracy === false ? evidenceFindings(checkpoint, article || checkpoint.core) : [])])];
  const report = checkpoint.report;
  const evidence = report ? `<details class="fold review-evidence"><summary>Brief coverage &amp; evidence</summary><p>These mappings describe the generated draft at its last AI review. Check them against your brief and originals.</p><h3>Requested points</h3><ul>${report.requirements.map((item) => `<li><strong>${esc(item.brief_quote)}</strong><p>${item.covered ? "Draft passage" : "Needs attention"}: ${esc(item.article_quote || "No matching passage found.")}</p></li>`).join("")}</ul><h3>Source support</h3><ul>${report.facts.map((item) => `<li><strong>${esc(item.claim)}</strong><blockquote>${esc(item.source_quote)}</blockquote><span>${esc(item.source_id)}</span></li>`).join("")}</ul></details>` : "";
  return `<div class="notice${(state === "needs_attention" || state === "accepted") ? " warning" : ""}"><strong>${esc(OUTPUT_FORMATS.find((f) => f.value === checkpoint.input.outputFormat)?.label || "Draft")}: ${label}</strong><p>${checkpoint.revision} of 3 revision rounds used. Evidence, brief coverage, section order and writing quality are checked. Check the findings before publication. Edits made after this review are not automatically checked.</p>${issues.length ? `<ul>${issues.map((issue) => `<li>${esc(issue)}</li>`).join("")}</ul>` : ""}${evidence}${state === "needs_attention" && articleId ? `<a class="btn" href="/articles/${esc(articleId)}/output">Download latest draft</a>` : ""}</div>`;
}

export function readinessSummary(report: ReadinessReport | null): string {
  if (!report || report.state === "checking") return "";
  return `<section class="notice${report.state === "needs_input" ? " warning" : ""}" aria-label="Brief readiness"><strong>${report.acceptance ? "Evidence gaps accepted by you — sources remain incomplete" : report.state === "ready" ? "Ready to draft" : "Before we write: a few details are needed"}</strong><p>${esc(report.summary)}</p>${report.gaps.length ? `<ol>${report.gaps.map((gap) => `<li><strong>${esc(gap.requirement)}</strong><p>${esc(gap.missing)}</p><p><strong>Next step:</strong> ${esc(gap.action)}</p></li>`).join("")}</ol>` : ""}<p class="field-help">This checks the supplied evidence, not every possible fact. Final editorial review still applies.</p></section>`;
}

export function runProgress(nav: Nav, run: Run, sources: SourceResult[] = [], reviews: { articleId: string; checkpoint: EditorialCheckpoint; article?: Article }[] = [], readiness: ReadinessReport | null = null, acceptanceToken = "", readinessToken = ""): string {
  const failed = run.state === "failed";
  const needsInput = run.state === "needs_input";
  const editorial = !!acceptanceToken || reviews.some((item) => item.checkpoint.state === "needs_attention"
    || /Editorial review needs attention/.test(run.error || "") && item.checkpoint.state === "review" && item.checkpoint.report !== null);
  const failure = runFailure(run.error, editorial);
  const drafting = run.state === "drafting_topics";
  const progress = progressFor(run.state);
  const body = `
<section${progress ? ` data-run-progress="${escAttr(run.id)}" data-state="${escAttr(run.state)}"` : ""}>
${stepper(drafting || needsInput || /^\[(ingest|assess|topics)\]/.test(run.error || "") ? 1 : 3)}
<div class="page-heading"><div class="eyebrow">${failed || needsInput ? "Let's get this back on track" : "Your content is in progress"}</div><h1 data-progress-heading>${esc(needsInput ? "Let's complete the brief before writing." : failed ? editorial ? "Your draft is ready for a decision" : "This run needs attention" : progress?.heading ?? "Your content is in progress.")}</h1></div>
<div class="card progress-card" role="status" aria-live="polite">
${needsInput ? readinessSummary(readiness) || `<p>Add readable source material using Edit brief, then check again. Writing has not started.</p>` : failed
  ? `<div class="notice warning"><strong>${esc(failure.title)}</strong><p>${esc(failure.detail)}</p><ol>${failure.actions.map((action) => `<li>${esc(action)}</li>`).join("")}</ol><p class="field-help">Step: ${esc(failure.stage)} · Reference: ${esc(run.id)} · ${esc(failure.code)}</p></div>`
  : `<p><span class="spinner" aria-hidden="true"></span><strong data-progress-label>${esc(progress?.label ?? STATE_LABEL[run.state] ?? run.state)}</strong></p>
<div class="progress-track">${[["Research", "Read sources"], ["Write", "Build the draft"], ["Review & revise", "Check and improve"], ["Visual", "Create for your channel"]].map(([label, detail], index) => `<div data-progress-stage="${index}" class="${index === progress?.stage ? "current" : index < (progress?.stage ?? 0) ? "complete" : ""}"><strong>${label}</strong>${detail}</div>`).join("")}</div>
<p class="field-help">You can leave this page and return from your history. Progress updates automatically without reloading the page.</p>
<p class="field-help" data-progress-connection style="min-height:20px"></p>
<noscript><p class="field-help">JavaScript is disabled. Refresh this page to check progress.</p></noscript>`}
${needsInput && readinessToken ? `<form method="post" action="/runs/${esc(run.id)}/accept-readiness"><h2>Proceed with the available sources</h2><p>You can continue despite these findings. This does not verify unsupported claims. The writer will adapt around supported material and omit unsupported specifics naturally, without missing-source commentary; final editorial review still applies.</p><input type="hidden" name="snapshot" value="${escAttr(readinessToken)}"><label class="exception-choice"><input type="checkbox" name="accept_gaps" value="yes" required> I understand the evidence gaps and want to proceed with the available sources.</label><p><button class="btn primary" type="submit">Ignore and continue</button></p><p class="field-help">Reuses saved sources and skips another readiness check. Next: choose an angle. Research, writing, review and images still use AI credits.</p></form>` : needsInput && readiness ? `<p class="field-help">At least one readable source is needed to continue. Retry unavailable sources or upload a readable copy using Edit brief.</p>` : ""}
${!needsInput && readiness?.acceptance ? readinessSummary(readiness) : ""}
${campaignActions(run.campaign_id)}
${failed && failure.canResume || needsInput && sources.some((source) => source.status === "unavailable") ? `<form method="post" action="/runs/${esc(run.id)}/resume"><button class="btn primary" type="submit">${needsInput ? "Retry unavailable sources" : "Resume saved run"}</button><p class="field-help">Successful source reads and completed steps stay saved.</p></form>` : ""}
${failed && editorial ? `<form method="post" action="/runs/${esc(run.id)}/recheck"><button class="btn" type="submit">Recheck saved draft</button><p class="field-help">Runs a fresh editorial review, with up to three revisions if needed. Uses AI credits.</p></form>` : ""}
</div>${reviews.map((item) => editorialSummary(item.checkpoint, item.articleId, item.article)).join("")}
${failed && acceptanceToken ? `<form class="card" method="post" action="/runs/${esc(run.id)}/accept-review"><h2>Keep this draft and continue</h2><p>Accept the listed findings as editorial exceptions. This does not verify unsupported claims or fix channel limits. The findings stay attached to your draft.</p><input type="hidden" name="snapshot" value="${escAttr(acceptanceToken)}"><label class="exception-choice"><input type="checkbox" name="accept_exceptions" value="yes" required> I have reviewed the draft and findings, accept these exceptions, and will verify claims before publication.</label><p><button class="btn primary" type="submit">Accept exceptions &amp; continue</button></p><p class="field-help">Keeps the saved text. No new writing or review calls. Remaining image generation may use AI credits.</p></form>` : ""}${sourceSummary(sources)}</section>`;
  return shell(nav, "Article progress", body, run.id);
}

/** Three-step progress indicator shown across the flow. */
function stepper(active: 1 | 2 | 3): string {
  const labels = ["Create a brief", "Choose an angle", "Review & export"];
  const cells = labels.map((label, idx) => {
    const n = idx + 1;
    const cls = n === active ? "active" : n < active ? "done" : "";
    const mark = n < active ? "✓" : String(n);
    const sep = n < labels.length ? `<span class="bar"></span>` : "";
    return `<div class="st ${cls}"><span class="n">${mark}</span><span>${esc(label)}</span></div>${sep}`;
  });
  return `<div class="steps">${cells.join("")}</div>`;
}

function extraChannels(primary: string, stored?: string): string {
  const selected = selectedChannels(primary, stored);
  return `<details class="fold"${selected.length > 1 ? " open" : ""}><summary>Additional destinations (optional)</summary><p class="field-help">Choose up to ${MAX_CHANNELS} destinations including the primary one. Research is shared; each destination gets its own draft, review, visual and exports. More destinations use more AI credits.</p><div class="channel-choices">${OUTPUT_FORMATS.map((format) => `<label class="channel-choice"><input type="checkbox" name="output_formats" value="${format.value}"${selected.includes(format.value as OutputFormat) ? " checked" : ""}${format.value === primary ? " disabled" : ""}><span><strong>${esc(format.label)}</strong><span class="field-help">${esc(channelProfile(format.value).summary)} ${esc(channelProfile(format.value).imageDescription)}</span></span></label>`).join("")}</div></details>`;
}

export function topicSelect(nav: Nav, run: Run, topics: Topic[], sources: SourceResult[] = [], preferredFormat = "html", readiness: ReadinessReport | null = null, preferredFormats?: string): string {
  const cards = topics
    .map((t, i) => {
      const desc = t.summary?.trim() || t.angle;
      const chips = `<span class="chip" title="The researched phrase this angle targets">Focus: ${esc(t.primary_kw)}</span>`;
      return `
<label class="angle">
  <input type="radio" name="topic" value="${esc(t.id)}"${i === 0 ? " checked" : ""}>
  <div class="angle-body">
    <div class="angle-title">${esc(t.title)}</div>
    <div class="angle-sum">${esc(desc)}</div>
    <div class="angle-meta"><span class="tag">${esc(t.angle)}</span>${chips}</div>
  </div>
</label>`;
    })
    .join("");

  const body = `
${stepper(2)}
<div class="page-heading"><div class="eyebrow">Choose your direction</div><h1>Which story should we tell?</h1>
<p>Choose the angle that best serves your audience. These suggestions are based on your brief, sources and current search context.</p></div>
${campaignActions(run.campaign_id)}
<form method="post" action="/runs/${esc(run.id)}/select" data-flow-form>
<div class="angles">${cards}</div>
<div class="gate">
  <div class="lbl-row">${lbl("Confirm the primary destination", "The destination controls length, formatting, image shape and export files.", "output_format")}</div>
  ${optionSelect("output_format", OUTPUT_FORMATS, isOutputFormat(preferredFormat) ? preferredFormat : "html")}
  ${extraChannels(preferredFormat, preferredFormats)}
  <p class="channel-spec" data-channel-spec aria-live="polite">${esc(channelProfile(preferredFormat).summary)}</p><p class="field-help">Presskit will review and revise the draft for this destination. <a href="/help#channels">Channel guide</a>.</p>
</div>
<div class="step-actions">
  <button class="primary" type="submit" title="Write the chosen angle in the selected format">Write &amp; review →</button>
  <button type="submit" formaction="/runs/${esc(run.id)}/regenerate" title="Discard these and propose three new angles">↻ Regenerate 3 titles</button>
  <span class="grow"></span>
  <span class="note">Refreshes remaining: ${Math.max(0, 5 - run.regen_count)} of 5</span>
</div>
<div class="form-error" data-form-error role="alert" tabindex="-1"></div>
</form>`;
  return shell(nav, "Choose an angle", readinessSummary(readiness) + body + sourceSummary(sources), run.id);
}

/** Metadata field (input or textarea) with a live copy button. Read-only when the
 *  result has no Save action (text formats), so the fields never look editable
 *  without a way to persist the change. */
function metaField(
  label: string,
  field: string,
  id: string,
  value: string,
  tip: string,
  area = false,
  readonly = false,
): string {
  const ro = readonly ? " readonly" : "";
  const dataAttr = readonly ? "" : ` data-field="${field}"`;
  const control = area
    ? `<textarea id="${id}"${dataAttr}${ro}>${esc(value)}</textarea>`
    : `<input id="${id}"${dataAttr} value="${esc(value)}"${ro}>`;
  return `<div><div class="lbl-row">${lbl(label, tip, id)}</div>
<div class="field">${control}<button class="copy" type="button" data-copy="${id}" title="Copy to clipboard">Copy</button></div></div>`;
}

// Minimal WYSIWYG toolbar. Uses execCommand (delegated in SCRIPT); no inline JS.
function toolbar(i: number, articleId: string, format: OutputFormat = "html"): string {
  const b = (cmd: string, label: string, title: string, val?: string) =>
    `<button type="button" data-cmd="${cmd}"${val ? ` data-val="${esc(val)}"` : ""} title="${escAttr(title)}">${label}</button>`;
  return `<div class="tb">
${format === "linkedin" ? "" : b("formatBlock", "H2", "Heading", "<h2>") + b("formatBlock", "H3", "Subheading", "<h3>")}
${b("formatBlock", "P", "Normal text", "<p>")}
${b("bold", "<strong>B</strong>", "Bold")}
${format === "linkedin" ? "" : b("italic", "<em>I</em>", "Italic")}
${b("insertUnorderedList", "• List", "Bulleted list")}
${b("insertOrderedList", "1. List", "Numbered list")}
${b("createLink", "Link", "Insert link")}
${b("removeFormat", "Clear", "Clear formatting")}
${b("undo", "↶", "Undo")}
${b("redo", "↷", "Redo")}
<span class="sp"></span>
<button type="button" class="copy" data-copy-rich="body_${i}" title="Copy with formatting for your destination editor">Copy content</button>
${format === "linkedin" ? `<button type="button" class="copy" data-copy-plain="body_${i}">Copy plain text</button>` : `<button type="button" class="copy" data-copy-html="body_${i}" title="Copy HTML for a code editor">Copy HTML</button>`}
<button type="button" data-cancel="${esc(articleId)}" title="Discard unsaved edits and revert to the last saved version">Cancel</button>
<button type="button" class="primary savebtn" data-save="${esc(articleId)}" title="Save edits (also refreshes the download bundle)">Save</button>
</div>`;
}

export function imageGallery(article: Article, versions: ImageVersion[]): string {
  const current = currentImageVersion(article);
  const saved = versions.length ? versions : current ? [{ id: current, createdAt: null }] : [];
  const cards = saved.map((version, index) => {
    const url = `/articles/${encodeURIComponent(article.id)}/images/${encodeURIComponent(version.id)}`;
    const featured = version.id === current;
    const label = `Version ${index + 1}`;
    const timestamp = version.createdAt ? `<time datetime="${esc(version.createdAt)}">${esc(version.createdAt.replace("T", " ").slice(0, 19))} UTC</time>` : "";
    return { featured, html: `<div class="image-version${featured ? " image-current" : ""}" data-image-version-card="${esc(version.id)}">
<div class="image-version-label"><strong>${label}</strong>${featured ? '<span class="fmtchip">Current image</span><span class="image-new-badge" data-image-new hidden>New</span>' : ""}${timestamp}</div>
<button class="thumb" type="button" data-zoom="${esc(url)}/featured.png" aria-label="Preview ${label} for ${esc(article.title)}"><img src="${esc(url)}/featured.png" alt="${label} of the featured visual for ${esc(article.title)}" loading="${featured ? "eager" : "lazy"}"><span class="zbadge">View full size</span></button>
<div class="image-version-downloads"><a class="btn${featured ? " primary" : ""}" href="${esc(url)}/featured.png" download title="Download the full-resolution featured visual as a PNG">${featured ? "Download Image" : `Download ${label}`}</a><a class="btn" href="${esc(url)}/image-brief">Download creative brief</a></div>
</div>` };
  });
  const featured = cards.find((card) => card.featured)?.html ?? '<div class="image-placeholder">No featured visual is available yet. Your article is saved and available to review and export.</div><button type="button" disabled title="Available once a visual has been generated">Download Image</button>';
  const previous = cards.filter((card) => !card.featured).reverse();
  return `${featured}${previous.length ? `<h3 class="image-history-heading">Saved images (${previous.length})</h3><p class="field-help">Every previous copy is kept here. Preview or download any version.</p><div class="image-history">${previous.map((card) => card.html).join("")}</div>` : ""}`;
}

export function resultScreen(nav: Nav, run: Run, list: Article[], jobs: ImageJob[] = [], galleries: Record<string, ImageVersion[]> = {}, reviews: Record<string, EditorialCheckpoint> = {}, sources: SourceResult[] = [], readiness: ReadinessReport | null = null, inlineReports: Record<string, InlineManifest | null> = {}): string {
  const sections = list
    .map((a, i) => {
      const imageJob = jobs.find((job) => job.article_id === a.id);
      const imagePending = imageJob?.state === "queued" || imageJob?.state === "working";
      const imageFailed = imageJob?.state === "failed";
      const visual = imageStatus(a, imageJob);
      const phrases = safeArr(a.key_phrases);
      const fmt: OutputFormat = isOutputFormat(a.output_format) ? a.output_format : "html";
      const rich = isRichFormat(fmt);
      const fmtLabel = OUTPUT_FORMATS.find((o) => o.value === fmt)?.label ?? "WordPress / Rich HTML";
      const fileLabels: Record<OutputFormat, string> = {
        html: "HTML (.html)",
        word: "Word (.doc)",
        markdown: "Markdown (.md)",
        plain: "Text (.txt)",
        social: "Text (.txt)", linkedin: "Text (.txt)", chat: "Message (.txt)", email: "Email (.html)",
      };
      const downloads = `<a class="btn" href="/articles/${esc(a.id)}/output" title="Download this article as a ${escAttr(fmtLabel)} file">↓ ${esc(fileLabels[fmt])}</a>${
        a.png_r2_key
          ? `<a class="btn" data-featured-download href="/articles/${esc(a.id)}/images/${esc(visual.version!)}/featured.png" download title="Download the featured image image">↓ Image</a>`
          : ""
      }<a class="btn" href="/articles/${esc(a.id)}/bundle.zip" title="Download a zip of the article in ${escAttr(fmtLabel)} format, meta.json, and the infographic when present">↓ Download all (zip)</a>`;

      const words = rich ? countWords(a.body_html) : a.output_body.trim().split(/\s+/).filter(Boolean).length;
      // The body area depends
      // the WYSIWYG editor; text formats (markdown/plain/social) get a read-only
      // copyable box holding the already-rendered output.
      const bodyBlock = rich
        ? `<div class="sec">${isCampaignChannel(fmt) ? "Message" : "Article"} <span class="fmtchip" title="This article was written and formatted for ${escAttr(fmtLabel)}.">${esc(fmtLabel)}</span>${hint("Edit the article directly in the box below, like a document. Use the toolbar for headings, bold, lists and links. Save keeps your changes and refreshes the downloadable bundle; Cancel reverts to the last saved version.")}</div>
<div class="editor">
${toolbar(i, a.id, fmt)}
<div class="rte" id="body_${i}" contenteditable="true" spellcheck="true">${a.body_html}</div>
</div>
<div class="savebar"><span class="note">${fmt === "email" ? "Copy the body into your email builder, or import the downloaded HTML. Add the image and sending footer there." : fmt === "linkedin" ? "Copy content includes bold highlights where LinkedIn accepts formatted paste. Copy plain text is the fallback; check the post composer before publishing." : "Copy content for a visual editor; Copy HTML for a code editor."} Save to keep edits. <a href="/help#export">Export help</a>.</span></div><p class="field-help" data-save-status role="status"></p>`
        : `<div class="sec">Formatted for <span class="fmtchip">${esc(fmtLabel)}</span>${hint("This is the article rendered for the platform you chose at the gate. It is plain text (no HTML), safe to paste straight into that platform. Copy it, or download the file.")}<button type="button" class="copy" data-copy="out_${i}" title="Copy the formatted text">Copy</button></div>
<pre class="outbox" id="out_${i}">${esc(a.output_body)}</pre>`;

      return `
<div class="card artcard" id="card_${esc(a.id)}" data-format="${fmt}">
${reviews[a.id] ? editorialSummary(reviews[a.id]!, a.id, a) : ""}
<div class="review-strip"><span class="fmtchip">${esc(fmtLabel)}</span><span>${words} words</span><span>${esc(channelProfile(fmt).imageDescription)}</span><span>Saved draft</span></div>
${inlineReports[a.id] ? `<p class="field-help" role="status">Inline illustrations: ${inlineReports[a.id]!.slots.filter((slot) => slot.state === "ready").length} ready.${inlineReports[a.id]!.error ? ` ${esc(inlineReports[a.id]!.error!)}` : " Included in the body and download bundle."}</p>` : ""}
<div class="arthead">
  <div class="titleblock" data-title-view aria-label="Article title">${esc(a.title)}</div>
  <div class="acts">${downloads}</div>
</div>
${
  a.similar_to
    ? `<div class="simbadge" title="This article closely resembles one you generated before. It was still created; review it so you are not publishing a near-duplicate.">⚠ Similar to an earlier article you made: <strong>${esc(
        a.similar_to,
      )}</strong> (${Math.round((a.similar_score || 0) * 100)}% match)</div>`
    : ""
}
${bodyBlock}
<details class="fold" open><summary>Featured visual <span class="summary-note" data-image-summary>${imagePending ? "Generating…" : a.png_r2_key ? "Preview & download" : "Unavailable"}</span></summary>
<div data-image-panel="${esc(a.id)}" data-image-pending="${imagePending}" data-has-image="${Boolean(a.png_r2_key)}" data-image-version="${esc(visual.version ?? "")}" data-image-revision="${esc(visual.revision)}">
<p class="image-status${imagePending ? " is-pending" : imageFailed ? " is-error" : ""}" data-image-status role="status" aria-live="polite" aria-atomic="true">${imagePending ? "Creating your new image. All previous copies are kept." : esc(imageJob?.error ?? "")}</p>
<div class="image-actions">
<button type="button" data-image-mode="retry"${imagePending || (a.png_r2_key && !imageFailed) ? " disabled" : ""} title="Retry image generation using the saved brief when the article has not changed">Retry</button>
<button type="button"${a.png_r2_key ? "" : ' class="primary"'} data-image-mode="new"${imagePending ? " disabled" : ""} title="Create a fresh evidence-backed brief and replacement image without changing the article">Generate New</button>
</div>
<p class="field-help">Generate New explores a different visual concept and keeps every previous copy. Retry reuses saved instructions when available. Both use paid image generation; your article is unchanged.</p>
<div data-image-gallery>${imageGallery(a, galleries[a.id] ?? [])}</div>
</div>
</details>
<details class="fold"${fmt === "email" ? " open" : ""}><summary>${fmt === "email" ? "Email subject &amp; preview" : isCampaignChannel(fmt) ? "Content details" : "SEO &amp; metadata"}</summary>
<div class="metagrid">
${metaField(fmt === "email" ? "Subject (up to 60 characters)" : "Heading / Title", "title", `title_${i}`, a.title, "The article headline shown in the block at the top of this card.", false, !rich)}
<div${isCampaignChannel(fmt) ? " hidden" : ""}>${metaField("Slug", "slug", `slug_${i}`, a.slug, "The URL-friendly page name, e.g. cloud-pbx-malaysia. Paste into your post's permalink / slug.", false, !rich)}
${metaField("Meta description", "meta", `meta_${i}`, a.meta_desc, "The short summary (<=160 chars) search engines show under your title. Paste into your SEO plugin's meta description.", true, !rich)}</div>
${metaField(fmt === "email" ? "Preview text (up to 100 characters)" : "Excerpt", "excerpt", `excerpt_${i}`, a.excerpt, "A short summary of the article, used in article listings, cards and previews.", true, !rich)}
<div${isCampaignChannel(fmt) ? " hidden" : ""}>${metaField("Focus keyphrase (Yoast)", "fkp", `fkp_${i}`, phrases[0] ?? "", "The one phrase to paste into Yoast SEO's Focus keyphrase box. Yoast rejects commas, so this is always a single clean phrase: the primary keyword this article targets. To change it, edit the first phrase in the list below and Save.", false, true)}
${metaField("Key phrases (comma separated)", "kp", `kp_${i}`, phrases.join(", "), "All SEO keywords this article targets, separated by commas. Do NOT paste this whole list into Yoast's Focus keyphrase box (it rejects commas) — use the single Focus keyphrase field above. This list suits tags or plugins that accept multiple phrases.", false, !rich)}</div>
</div>
<p class="note" style="font-size:12px;color:var(--faint);margin:12px 0 2px">${
      rich
        ? "These save together with the article when you click <strong>Save</strong>."
        : "Read-only for this format. Copy any field you need with its <strong>Copy</strong> button."
    }</p>
</details>
</div>`;
    })
    .join("");

  const body = `
${stepper(3)}
<div class="page-heading"><div class="eyebrow">Your content workspace</div><h1>Review &amp; export</h1><p>Your draft has been reviewed, improved and adapted for its destination. Review it, make any edits, then export.</p></div>
${campaignActions(run.campaign_id)}
<div class="notice"><strong>Review before publication.</strong> Verify names, claims, figures and image labels against your original sources. Check your links and call to action. Article edits do not regenerate the visual; recheck it after editing.</div>
${list.length > 1 ? `<nav aria-label="Channel outputs" class="help-nav">${list.map((a) => `<a href="#card_${esc(a.id)}">${esc(OUTPUT_FORMATS.find((f) => f.value === a.output_format)?.label || a.output_format)}</a>`).join("")}</nav>` : ""}
${readiness?.acceptance ? readinessSummary(readiness) : ""}
${sections}`;
  return shell(nav, "Result", body + sourceSummary(sources), run.id);
}

function safeArr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function helpScreen(nav: Nav): string {
  return shell(nav, "Presskit guide", `<div class="page-heading"><div class="eyebrow">A practical guide</div><h1>Better briefs. Useful content.</h1><p>Choose a destination, supply the facts, and let Presskit draft, check and improve the result.</p></div>
<nav class="help-nav" aria-label="Guide sections"><a href="#start">Start here</a><a href="#brief">Write a brief</a><a href="#sources">Sources</a><a href="#channels">Channels</a><a href="#review">Automatic review</a><a href="#images">Images</a><a href="#export">Export</a><a href="#history">History</a></nav>
<section class="card help-section" id="start"><h2>Your first piece</h2><ol><li>Start a new brief. Name the audience, goal and points you need covered.</li><li>Choose the destination and add source URLs or a document.</li><li>Presskit checks whether the readable sources support your brief. Fix any listed gaps, then choose one of three angles.</li><li>Presskit writes, independently reviews and revises the draft, then creates a matching visual.</li><li>Review the result and export it. Your content stays in History.</li></ol><a class="btn primary" href="/">Create a brief →</a></section>
<section class="card help-section" id="brief"><h2>Give the writer a clear job</h2><p><strong>Auto decide:</strong> enter your brief and sources, then use the large button to let AI read the content and suggest settings. Suggested fields are highlighted. Review them and submit when ready. It never starts generation by itself. Jobs run in the background, retry temporary failures, allow two active jobs and ten requests per hour, and expire after 24 hours.</p><p><strong>Storytelling</strong> builds a narrative around supported facts or an explicitly illustrative scenario. <strong>Fictional story</strong> creates invented characters and events, identified once as fiction; sources are optional for pure fiction. Real product, legal and measured claims still need evidence.</p><p>Tell us <strong>who is reading, what they should learn or do, which points matter, and in what order</strong>. Include examples, product differences and real constraints in your sources. A role or tone setting cannot supply missing facts.</p><pre class="outbox" id="brief-example">Audience: Malaysian SME operations managers.
Goal: Help them plan a phone-system migration.
Destination: LinkedIn post.
Must cover, in order: assess the network, run a small pilot, then review before a wider rollout.
Emphasis: Keep the existing system available during the pilot.
Avoid: Unsupported savings, prices or guarantees.
Next step: Read our migration checklist.
Evidence: Add the checklist URL or upload its text.</pre><button class="btn" type="button" data-copy="brief-example">Copy brief example</button><p>A long brief may not fit a short message. Keep the essentials, choose a longer channel, or create separate pieces. Presskit flags unresolved conflicts rather than approving an incomplete draft.</p></section>
<section class="card help-section" id="source-limits"><h2>Input limits</h2><ul><li><strong>Uploads:</strong> one new file per submission, up to 10 MB (10,000,000 bytes). PDF, Word, Excel, PowerPoint, CSV, text, HTML and Markdown are supported.</li><li><strong>Extracted text:</strong> at least 40 readable characters, up to 60,000 characters per document, roughly 10,000 English words. There is no fixed page limit. Files below 10 MB can still exceed this text limit; use only the relevant pages, slides or sheets.</li><li><strong>Source URLs:</strong> up to 10 in the Source URLs field.</li><li><strong>Brief:</strong> up to 12,000 characters. Ideas to include and Topics to avoid: up to 6,000 characters each.</li><li><strong>Combined evidence:</strong> readiness checks and writing share a budget of up to 60,000 characters across all sources. Larger collections use excerpts selected for relevance, rather than every passage. Supporting details outside these excerpts can be missed.</li></ul><p>When editing, saved documents remain attached and are shown with their extraction status. You do not need to upload them again. Adding a new file adds to the saved collection. An unreadable document stays listed but cannot support claims until a readable copy is available.</p></section>
<section class="card help-section" id="sources"><h2>Make your references usable</h2><p><strong>Readiness override:</strong> If readable sources exist but some requested details are unsupported, review the listed gaps, acknowledge them and choose <strong>Ignore and continue</strong>. This skips another readiness check and preserves the warnings through export. It does not verify claims or disable final editorial review. If no source could be read, upload or retry a source first.</p><p><strong>Before writing:</strong> Presskit checks the requested facts against the sources it could actually read. One relevant source can be enough. An unavailable optional link does not automatically block the run. If a required statistic, attribution, comparison or other essential detail is missing, the readiness report names it and tells you what to upload, replace or change. Source access, missing evidence, editorial findings and AI service errors have separate next steps.</p><p>Add up to 10 public source URLs and a PDF, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.ppt/.pptx), CSV or text document up to 10 MB. Sources can include product documentation, approved statements and research. Use direct document links where possible.</p><p>The source report tells you what was read and what failed. Cloudflare Browser Rendering tries pages that need JavaScript when a normal fetch cannot read the content. Sites behind a login or blocking automated browsers still need a readable copy. Encrypted documents need to be unlocked; legacy files and image-only slides may work better exported to PDF. Extraction runs in the background after upload. GPT-6 Luna converts recovered document content to Markdown. Download the .md file from Research sources to check what was read. Search helps identify audience questions; it does not turn unverified search results into product evidence.</p><p>Do not put a claim only in the brief and expect it to be verified. Supply the supporting material too.</p></section>
<section class="card help-section" id="channels"><h2>Write for the destination</h2><p>Choose a primary destination and optional additional destinations (up to four total), then confirm them with your angle. One run shares research and creates a distinct draft, review, image and export for each selected destination. More destinations use more AI credits. Give channel-specific instructions in the brief, for example: ‘WordPress: detailed guide; WhatsApp: short teaser with a link.’ These are Presskit's editorial limits. Your lower word limit still applies. Each destination changes the writing instructions, review checks, image composition and exports.</p><div class="table-scroll"><table class="channel-table"><thead><tr><th>Destination</th><th>Writing &amp; formatting</th><th>Visual</th></tr></thead><tbody>${OUTPUT_FORMATS.map((format) => `<tr><th>${esc(format.label)}</th><td>${esc(channelProfile(format.value).summary)}</td><td>${esc(channelProfile(format.value).imageDescription)}</td></tr>`).join("")}</tbody></table></div><p><strong>LinkedIn:</strong> copy with basic bold highlights or use plain text. Formatted paste support can vary by composer; check the preview. Presskit does not replace letters with decorative Unicode characters.</p><p><strong>WhatsApp / Chat:</strong> copied text uses <code>*bold*</code> and <code>_italic_</code>. Other chat apps may display these differently. Preview before sending.</p><p><strong>Email:</strong> the subject and preview text are separate from the body. The HTML uses a single 600-pixel column. Upload the PNG to your email platform and let that platform handle the sending footer, sender details and unsubscribe link.</p></section>
<section class="card help-section" id="review"><h2>The editor keeps improving the draft</h2><p>If review stops with unresolved findings, download and inspect the saved draft. Accept exceptions to keep it and continue without more writing/review calls, or request a paid recheck. Acceptance does not verify claims or fix limits; warnings remain visible. Remaining images may still use credits.</p><p>A separate review checks facts against source quotes, maps requested points to the draft, checks order, removes generic filler and checks channel fit. Failed checks produce specific revision instructions. New generations read the sources, plan scenarios, draft, review, improve the full draft at least once, then review again. Each step is checkpointed. Optional research can read up to two additional public sources; search summaries alone are ideas, not evidence. Review remains bounded to three revision rounds.</p><p>If material problems remain, the run stops with specific findings and the latest draft available to download. Edit the brief or add evidence only where the findings call for it. If a finding appears incorrect, Recheck saved draft starts a fresh review without rewriting from scratch. The loop is bounded; it cannot guarantee perfect writing or factual accuracy.</p><p>Timeouts and temporary provider errors retry in the background with saved progress. A watchdog recovers interrupted queue hand-offs. You can leave the progress page: work continues and the page updates automatically when you return. Manual edits after the automated review need your own check.</p></section>
<section class="card help-section" id="images"><p><strong>Inline images:</strong> choose 1–3 illustrations in the brief to place extra images alongside relevant passages in WordPress, email, Word and Markdown. Each costs an additional image generation; social and chat keep the hero only. ZIP downloads include the PNG/SVG files used in the body. SVG diagrams are supported for WordPress and Markdown; email and Word use PNG images for compatibility. Upload these to your website or email media library and replace paths before publishing. A failed illustration leaves the article and other images available.</p><h2>Images that fit the message</h2><p>Claude compares three visual concepts, weighs their strengths and weaknesses, then specifies the winning scene, composition, materials, light and colour. OpenAI Image 2.5 Sunburst renders that one image. Bold editorial is the default for new briefs; photography, dimensional art and explanatory diagrams are also available. Use Creative direction for brand colours, mood and exclusions. Articles and email use landscape images; LinkedIn and chat use square images. Important information should also appear in the text.</p><p>Images are composed with extra background for cropped previews: 20% above and below landscape visuals, 30% for square visuals, and 10% on each side. Important subjects and text are directed into the centre. Check the destination preview before publishing; crops and generated framing can vary.</p><p><strong>Generate New</strong> uses the previous creative brief to explore a different scene or metaphor, creates a fresh version, marks it as new and updates the gallery without a page refresh. Every previous image remains available to preview or download. <strong>Retry</strong> resumes a failed image request using saved instructions where available. Both use paid generation.</p><p>Editing the draft does not change existing images. Generate a new image if the visual no longer matches, and check labels and claims before using it.</p></section>
<section class="card help-section" id="history"><h2>Organise past work</h2><p>Open <a href="/history">History → Manage</a> to search titles and briefs, select items and move them into named groups. Type a new group name or leave it blank to ungroup. Archive hides selected runs from the sidebar; use the Archive tab to find and restore them. Archiving keeps all content and does not stop background work.</p><p>Delete shows a separate confirmation listing the selected runs. It removes their articles and all image versions. Other runs from the same brief are kept; sources are removed only when the last run is deleted. Files are cleaned up in the background. A run that is still generating must finish before deletion.</p></section>
<section class="card help-section" id="export"><h2>Copy or download</h2><ul><li><strong>Website:</strong> Copy content into a visual editor, or Copy HTML into a code editor.</li><li><strong>LinkedIn:</strong> Copy content for basic formatted paste; Copy plain text when formatting is unavailable. Upload the PNG separately.</li><li><strong>Email:</strong> use the subject and preview fields; import the HTML or paste the body into your email builder. Upload the visual and send a test email.</li><li><strong>WhatsApp / Chat:</strong> copy the message and attach the image separately. Check emphasis in the destination app.</li><li><strong>Download all:</strong> a ZIP with the chosen format, details and current image. Email also includes a plain-text alternative and setup notes. Older images remain in Saved images.</li></ul><p>Presskit prepares drafts and exports. Sending and publishing happen in your destination tool.</p></section>`);
}
