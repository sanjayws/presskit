/** Background updates are confined to the visual; never replace the editor. */
export const IMAGE_PROGRESS_SCRIPT = `
var imagePanels=new WeakMap();
function requestImage(button){var panel=button.closest('[data-image-panel]');var state=imagePanels.get(panel);if(state)state.request(button.dataset.imageMode);}
function watchImages(panel){
 var path='/articles/'+encodeURIComponent(panel.dataset.imagePanel);
 var card=panel.closest('.artcard'),fold=panel.closest('details');
 var status=panel.querySelector('[data-image-status]'),summary=fold.querySelector('[data-image-summary]');
 var timer=null,controller=null,inFlight=false,requesting=false,active=true,stopped=false,epoch=0,started=Date.now(),requestIssue='';
 function message(text,kind){
  if(status.textContent!==text)status.textContent=text;
  var className='image-status'+(kind?' is-'+kind:'');if(status.className!==className)status.className=className;
 }
 function buttons(busy,failed){
  panel.dataset.imagePending=String(busy);
  panel.querySelectorAll('[data-image-mode]').forEach(function(button){
   button.disabled=busy||(button.dataset.imageMode==='retry'&&panel.dataset.hasImage==='true'&&!failed);
   if(button.dataset.imageMode==='new')button.textContent=busy?'Generating…':'Generate New';
  });
 }
 function schedule(delay){clearTimeout(timer);if(active&&!stopped&&!document.hidden)timer=setTimeout(check,delay);}
 function stop(text){stopped=true;clearTimeout(timer);message(text,'error');}
 async function getJson(url){
  var response=await fetch(url,{headers:{accept:'application/json'},cache:'no-store',redirect:'error',signal:controller.signal});
  if(response.status===401){stop('Your session expired. Sign in again to check your images.');return null;}
  if(response.status===404){stop('This article is no longer available. Open another article from your history.');return null;}
  if(!response.ok)throw new Error('Image update unavailable');
  return response.json();
 }
 async function refreshGallery(ticket){
  var result=await getJson(path+'/images');
  if(!result||ticket!==epoch||!active||document.hidden)return null;
  if(typeof result.html!=='string'||typeof result.revision!=='string')throw new Error('Invalid image update');
  var isNew=Boolean(result.version&&result.version!==panel.dataset.imageVersion);
  panel.querySelector('[data-image-gallery]').innerHTML=result.html;
  panel.dataset.imageVersion=result.version||'';
  panel.dataset.imageRevision=result.revision;
  panel.dataset.hasImage=String(result.hasImage);
  if(result.version){
   var link=card.querySelector('[data-featured-download]');
   if(!link){link=document.createElement('a');link.className='btn';link.dataset.featuredDownload='';link.setAttribute('download','');link.textContent='↓ Image';card.querySelector('.arthead .acts').appendChild(link);}
   link.href=path+'/images/'+encodeURIComponent(result.version)+'/featured.png';
  }
  if(isNew){
   requestIssue='';
   var badge=panel.querySelector('[data-image-new]');if(badge)badge.hidden=false;
   fold.open=true;summary.textContent='New image ready';
   message(result.count>1?'New image ready. Showing the new version; all previous copies are saved below.':'New image ready. You can preview or download it below.','success');
   toast('New image ready');
  }
  return result;
 }
 async function check(){
  if(stopped||!active||document.hidden||inFlight||requesting)return;
  inFlight=true;var ticket=epoch;controller=new AbortController();
  var timeout=setTimeout(function(){if(controller)controller.abort();},15000);
  try{
   var result=await getJson(path+'/image-status');
   if(!result||ticket!==epoch||!active||document.hidden)return;
   if(['idle','queued','working','ready','failed'].indexOf(result.state)<0||typeof result.revision!=='string')throw new Error('Invalid image status');
   var busy=result.state==='queued'||result.state==='working';
   if((result.version||'')!==panel.dataset.imageVersion||(!busy&&result.revision!==panel.dataset.imageRevision)){
    result=await refreshGallery(ticket);if(!result)return;
    busy=result.state==='queued'||result.state==='working';
   }
   var wasBusy=panel.dataset.imagePending==='true';
   buttons(busy,result.state==='failed');
   if(busy){
    if(!wasBusy)started=Date.now();
    summary.textContent='Generating…';
    message(Date.now()-started>600000?'This is taking longer than usual. Still checking automatically; all saved images are safe.':result.state==='queued'?'Your new image is queued. All previous copies are kept.':'Creating your new image. It will appear here automatically.','pending');
   }else if(result.state==='failed'){
    summary.textContent='Generation needs attention';
    message(result.error||'The new image could not be created. Your saved images are still available.','error');
   }else if(requestIssue){summary.textContent='Generation needs attention';message(requestIssue,'error');}
   else if(!result.hasImage){summary.textContent='Unavailable';message('No visual is available yet. Retry to create it.','');}
   else if(!status.classList.contains('is-success')){
    summary.textContent='Preview & download';message(wasBusy?'Your images are up to date. All copies are saved.':'','');
   }
  }catch(error){if(ticket===epoch&&active&&!document.hidden)message('Connection interrupted. Retrying automatically; your article and saved images are safe.','error');}
  finally{clearTimeout(timeout);controller=null;inFlight=false;schedule(panel.dataset.imagePending==='true'?4000:15000);}
 }
 async function request(mode){
  if(requesting||panel.dataset.imagePending==='true'||stopped)return;
  if(card.classList.contains('dirty')){requestIssue='Save or cancel your article edits before generating its visual.';message(requestIssue,'error');return;}
  if(mode==='new'&&!confirm('Generate a new image and creative brief? This uses paid generation. Every previous image will be kept.'))return;
  requesting=true;requestIssue='';epoch++;started=Date.now();clearTimeout(timer);if(controller)controller.abort();
  buttons(true,false);fold.open=true;summary.textContent='Generating…';message('Queuing your new image. All previous copies are kept.','pending');
  var requestController=new AbortController();var timeout=setTimeout(function(){requestController.abort();},15000);
  try{
   var response=await fetch(path+'/image',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({mode:mode}),signal:requestController.signal,redirect:'error'});
   var result=await response.json().catch(function(){return {};});
   if(response.status===401){stop('Your session expired. Sign in again to continue.');return;}
   if(response.status===202||(response.status===409&&result.jobId))return;
   requestIssue=result.error||'The image request could not be accepted. Try again.';
   buttons(false,true);summary.textContent='Generation needs attention';message(requestIssue,'error');
  }catch(error){message('Connection interrupted. Checking automatically whether your image was queued.','error');}
  finally{clearTimeout(timeout);requesting=false;schedule(1000);}
 }
 imagePanels.set(panel,{request:request});
 document.addEventListener('visibilitychange',function(){clearTimeout(timer);if(document.hidden){if(controller)controller.abort();}else schedule(0);});
 window.addEventListener('pagehide',function(){active=false;clearTimeout(timer);if(controller)controller.abort();});
 window.addEventListener('pageshow',function(event){if(event.persisted){active=true;schedule(0);}});
 buttons(panel.dataset.imagePending==='true',status.classList.contains('is-error'));
 schedule(panel.dataset.imagePending==='true'?0:15000);
}
document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-image-panel]').forEach(watchImages);});
`;
