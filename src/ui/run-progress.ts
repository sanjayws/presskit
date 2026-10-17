import type { RunState } from "../db/repos";

/** Shared by the server-rendered progress view and its in-place updates. */
export const RUN_PROGRESS = {
  drafting_topics: {
    heading: "Checking your brief and sources.",
    label: "Reading sources before we start writing…",
    history: "drafting",
    stage: 0,
  },
  writing: {
    heading: "Writing a useful, grounded draft.",
    label: "Writing for your chosen channel…",
    history: "writing",
    stage: 1,
  },
  styling: {
    heading: "Reviewing and improving your draft.",
    label: "Checking evidence, brief coverage and writing quality…",
    history: "reviewing",
    stage: 2,
  },
  asset_gen: {
    heading: "Creating the featured visual.",
    label: "Rendering featured image…",
    history: "imaging",
    stage: 3,
  },
} as const;

export function progressFor(state: RunState) {
  if (state === "drafting_topics" || state === "writing" || state === "styling" || state === "asset_gen") {
    return RUN_PROGRESS[state];
  }
  return null;
}

/** Runs only on progress pages, inside the existing nonce-protected script. */
export const RUN_PROGRESS_SCRIPT = `
(function(){
 var panel=document.querySelector('[data-run-progress]');if(!panel)return;
 var states=${JSON.stringify(RUN_PROGRESS)};
 var path='/runs/'+encodeURIComponent(panel.dataset.runProgress);
 var timer=null,inFlight=false,stopped=false,active=true,controller=null;
 var note=panel.querySelector('[data-progress-connection]');
 function message(text){if(note.textContent!==text)note.textContent=text;}
 function stop(text){stopped=true;clearTimeout(timer);message(text);}
 function schedule(delay){clearTimeout(timer);if(!stopped&&active&&!document.hidden)timer=setTimeout(check,delay);}
 async function check(){
  if(stopped||!active||document.hidden||inFlight)return;
  inFlight=true;controller=new AbortController();
  var timeout=setTimeout(function(){controller.abort();},15000);
  try{
   var response=await fetch(path+'/status',{headers:{accept:'application/json'},cache:'no-store',redirect:'error',signal:controller.signal});
   if(response.status===401){stop('Your session expired. Sign in again to check this run.');return;}
   if(response.status===404){stop('This run is no longer available. Open another run from your history.');return;}
   if(!response.ok)throw 0;
   var result=await response.json();
   if(!active||document.hidden)return;
   var state=result&&result.state;
   if(state==='awaiting_topic_selection'||state==='ready'||state==='failed'||state==='needs_input'){
    stop('Opening the next step…');location.assign(path);return;
   }
   if(state==='drafting_topics'){
    panel.querySelector('[data-progress-label]').textContent=result.stage==='assess'?'Checking whether your sources support the requested points…':result.stage==='topics'?'Brief check complete. Proposing three angles…':'Reading your supplied sources…';
   }
   if(!Object.prototype.hasOwnProperty.call(states,state))throw 0;
   if(panel.dataset.state!==state){
    var progress=states[state];panel.dataset.state=state;
    panel.querySelector('[data-progress-heading]').textContent=progress.heading;
    panel.querySelector('[data-progress-label]').textContent=progress.label;
    panel.querySelectorAll('[data-progress-stage]').forEach(function(cell){
     var stage=Number(cell.dataset.progressStage);
     cell.classList.toggle('current',stage===progress.stage);cell.classList.toggle('complete',stage<progress.stage);
    });
    var history=document.querySelector('.histitem[aria-current=page] .s');if(history)history.textContent=progress.history;
   }
   if(state==='styling'&&result.editorial){
    var review=result.editorial;
    panel.querySelector('[data-progress-label]').textContent=review.state==='passed'?'Editorial review passed':review.state==='revise'?'Revising the draft · round '+(Number(review.revision)+1)+' of 3':Number(review.revision)>0?'Reviewing revision '+Number(review.revision)+' of 3':'Reviewing the complete draft';
   }
   message(result.retrying?'The provider is taking longer than usual. Your progress is saved; this step will retry automatically in the background.':'');
  }catch(error){if(active&&!document.hidden)message('Connection interrupted. Checking again shortly; your work continues.');}
  finally{clearTimeout(timeout);controller=null;inFlight=false;schedule(5000);}
 }
 document.addEventListener('visibilitychange',function(){
  clearTimeout(timer);
  if(document.hidden){if(controller)controller.abort();}else schedule(0);
 });
 window.addEventListener('pagehide',function(){active=false;clearTimeout(timer);if(controller)controller.abort();});
 window.addEventListener('pageshow',function(event){if(event.persisted){active=true;schedule(0);}});
 schedule(5000);
})();
`;
