import { type BuildImage, uploadedImageUrl, runImages } from "../images/uploads";
import type { Article, Run } from "../db/repos";
const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const roles = (name: string, current = "inline") => `<label for="${name}">Use as</label><select id="${name}" name="${name}">${[["inline","Inside article"],["hero","Hero image"],["attachment","Download only"]].map(([value,label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`).join("")}</select>`;
export function imageUploadFields(campaignId?: string, images: BuildImage[] = []): string {
  return `<details class="fold" open><summary>Your images <span class="summary-note">Optional · screenshots &amp; photos</span></summary>
<p>Add your own visuals. Choose one as the hero to replace AI generation, or place screenshots inside the article alongside any generated illustrations.</p>
<p class="field-help">PNG, JPEG or still WebP (email/Word hero and inline images need PNG/JPEG). Up to 6 selected images, 3 MB each (3,000,000 bytes), 10 MB combined. Maximum 8,192 pixels per side and 24 megapixels. Uploads keep their original shape and bytes; check crops and remove sensitive details before uploading. Images illustrate the article; add readable source text for factual claims. <a href="/help#your-images">Image upload help</a>.</p>
<input type="hidden" name="images_present" value="yes">
<div class="build-image-list">${images.map((image) => `<div class="build-image" data-saved-image data-content-type="${image.content_type}" data-bytes="${image.bytes}">
<img class="build-image-preview" src="/campaigns/${esc(campaignId || "")}/images/${image.id}" alt="${esc(image.description)}" width="160" loading="lazy">
<div><label class="exception-choice"><input type="checkbox" name="keep_image" value="${image.id}" checked> Keep ${esc(image.filename)} for the next run</label><p class="field-help">${image.width} × ${image.height} · ${(image.bytes / 1000000).toFixed(2)} MB. Deselect to remove from the next run; older runs keep their copy.</p>
${roles(`image_role_${image.id}`, image.role)}<label for="image_description_${image.id}">Description / alt text</label><input id="image_description_${image.id}" name="image_description_${image.id}" maxlength="240" value="${esc(image.description)}"></div></div>`).join("")}
${Array.from({ length: 6 }, (_, i) => `<div class="build-image" data-new-image="${i}"><img class="build-image-preview" data-image-preview alt="Selected image preview" width="160" hidden>
<div><label for="image_${i}">Image ${i + 1}</label><input id="image_${i}" type="file" name="image_${i}" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" data-build-image>
<p class="field-help" data-image-file-status role="status"></p>${roles(`image_role_${i}`)}<label for="image_description_${i}">Description / alt text</label><input id="image_description_${i}" name="image_description_${i}" maxlength="240" placeholder="e.g. Screenshot of the call-routing settings. Place near the setup explanation.">
<button type="button" class="btn" data-clear-image>Clear image</button></div></div>`).join("")}</div>
<button type="button" class="btn" data-add-build-image hidden>Add another image</button>
<p class="field-help">Descriptions guide AI placement and become image alt text. Inside-article uploads work for WordPress, Markdown, email and Word. LinkedIn, chat and plain text keep separate attachments in the ZIP. Without an uploaded hero, Presskit generates one. Uploaded originals remain available when generating a replacement.</p></details>`;
}

export function uploadedGallery(article: Article, run: Run): string {
  const images = runImages(run);
  if (!images.length) return "";
  return `<details class="fold" open><summary>Your uploaded images <span class="summary-note">${images.length} saved originals</span></summary><p class="field-help">Included in Download all. ${["html","markdown","email","word"].includes(article.output_format) ? "Inside-article images are placed using their descriptions; review placement in the draft/download." : "This channel keeps uploaded images as separate attachments."} Originals keep their aspect ratio; check the destination crop.</p><div class="uploaded-gallery">${images.map((image) => `<div class="uploaded-card"><button class="thumb" type="button" data-zoom="${uploadedImageUrl(article.id, image.id)}" aria-label="Preview ${esc(image.description)}"><img src="${uploadedImageUrl(article.id, image.id)}" alt="${esc(image.description)}" width="${image.width}" height="${image.height}" loading="lazy"></button><p><strong>${esc(image.filename)}</strong></p><p>${esc(image.description)}</p><p class="field-help">${image.role === "hero" ? "Uploaded hero" : image.role === "inline" ? "Inside article where supported" : "Download only"} · ${image.width} × ${image.height}</p><a class="btn" href="${uploadedImageUrl(article.id, image.id)}" download>Download original</a></div>`).join("")}</div></details>`;
}

export const UPLOAD_IMAGES_SCRIPT = `
function buildImageError(form){var files=Array.from(form.querySelectorAll('[data-build-image]')).flatMap(function(field){return Array.from(field.files);});var kept=Array.from(form.querySelectorAll('[data-saved-image]')).filter(function(row){return row.querySelector('[name=keep_image]').checked;});
 if(files.length+kept.length>6)return 'Choose up to 6 images including saved images. Deselect an old image before adding another.';
 if(files.some(function(file){return !file.size||file.size>3000000||!/\\.(png|jpe?g|webp)$/i.test(file.name);}))return 'Each image must be a PNG, JPEG or still WebP file of up to 3 MB.';
 if(files.reduce(function(n,f){return n+f.size;},0)+kept.reduce(function(n,row){return n+Number(row.dataset.bytes);},0)>10000000)return 'Selected images exceed 10 MB combined. Resize them or select fewer images.';
 var rows=kept.concat(Array.from(form.querySelectorAll('[data-new-image]')).filter(function(row){return row.querySelector('[type=file]').files.length;}));
 if(rows.filter(function(row){return row.querySelector('select').value==='hero';}).length>1)return 'Choose only one uploaded hero image.';
 var formats=[form.elements.namedItem('output_format').value].concat(Array.from(form.querySelectorAll('[name=output_formats]:checked')).map(function(box){return box.value;}));if(formats.some(function(value){return value==='email'||value==='word';})&&rows.some(function(row){var file=row.querySelector('[type=file]');return row.querySelector('select').value!=='attachment'&&(row.dataset.contentType==='image/webp'||file&&file.files[0]&&/\\.webp$/i.test(file.files[0].name));}))return 'Email and Word need PNG or JPEG visuals. Upload a PNG/JPEG copy or choose Download only for the WebP.';
 if(kept.some(function(row){return !row.querySelector('[name^=image_description_]').value.trim();}))return 'Describe each saved image in 1–240 characters.';
 return '';}
function updateBuildImageButton(form){var button=form.querySelector('[data-add-build-image]');if(button)button.hidden=!form.querySelector('[data-new-image][hidden]');}
document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-brief-form]').forEach(function(form){form.querySelectorAll('[data-new-image]').forEach(function(row,i){row.hidden=i>0;});updateBuildImageButton(form);});});
document.addEventListener('click',function(event){var add=event.target.closest('[data-add-build-image]');if(add){var form=add.closest('form');var row=form.querySelector('[data-new-image][hidden]');if(row){row.hidden=false;row.querySelector('[type=file]').focus();}updateBuildImageButton(form);return;}
 var clear=event.target.closest('[data-clear-image]');if(clear){var row=clear.closest('[data-new-image]');row.querySelector('[type=file]').value='';row.querySelector('[name^=image_description_]').value='';row.querySelector('[data-image-preview]').hidden=true;row.querySelector('[data-image-preview]').removeAttribute('src');row.querySelector('[data-image-file-status]').textContent='';}});
document.addEventListener('change',function(event){var field=event.target.closest('[data-build-image]');if(!field)return;var row=field.closest('[data-new-image]'),preview=row.querySelector('[data-image-preview]'),status=row.querySelector('[data-image-file-status]');var file=field.files[0];preview.hidden=true;preview.removeAttribute('src');if(!file){status.textContent='';return;}status.textContent=file.name+' · '+(file.size/1000000).toFixed(2)+' MB';
 if(!file.size||file.size>3000000||!/\\.(png|jpe?g|webp)$/i.test(file.name)){status.textContent='Select a PNG, JPEG or still WebP of up to 3 MB.';return;}
 var reader=new FileReader();reader.onload=function(){if(field.files[0]===file){preview.src=reader.result;preview.hidden=false;}};reader.readAsDataURL(file);});
`;
