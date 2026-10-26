import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";

// Keep provider fixtures explicit while using Cloudflare's supported MSW transport.
// Unmatched requests always fail locally; tests cannot contact paid providers.
export const network=setupNetwork();
type Options={path:string|RegExp;method?:string;body?:string|((body:string)=>boolean);headers?:Record<string,string>};
type ReplyOptions={body:string;path:string;method:string;headers:Record<string,string>};
type ReplyData=Record<string,unknown>|unknown[]|string|Uint8Array|ArrayBuffer|((request:ReplyOptions)=>unknown);
type Fixture={origin:string;options:Options;status:number;data:unknown|((request:ReplyOptions)=>unknown);headers?:Record<string,string>;remaining:number;delay:number};
let fixtures:Fixture[]=[];
const handler=()=>http.all("*",async({request})=>{
  const url=new URL(request.url),path=url.pathname+url.search,body=new TextDecoder().decode(await request.clone().arrayBuffer());
  const match=fixtures.find(f=>f.remaining>0&&f.origin===url.origin&&(f.options.method||"GET")===request.method
    &&(typeof f.options.path==="string" ? f.options.path===path : f.options.path.test(path))
    &&(f.options.body===undefined || (typeof f.options.body==="function" ? f.options.body(body) : f.options.body===body))
    &&Object.entries(f.options.headers||{}).every(([key,value])=>request.headers.get(key)===value));
  if(!match)return HttpResponse.error();
  match.remaining--;if(match.delay)await new Promise(r=>setTimeout(r,match.delay));
  const data=typeof match.data==="function" ? match.data({body,path,method:request.method,headers:Object.fromEntries(request.headers)}) : match.data;
  const binary=data instanceof Uint8Array || data instanceof ArrayBuffer;
  return new HttpResponse((binary||typeof data==="string" ? data : JSON.stringify(data)) as BodyInit,{status:match.status,headers:match.headers});
});
export const fetchMock={
  activate(){fixtures=[];network.resetHandlers();network.use(handler());},
  disableNetConnect(){},
  deactivate(){fixtures=[];network.resetHandlers();network.use(handler());},
  assertNoPendingInterceptors(){const pending=fixtures.filter(f=>f.remaining>0&&f.remaining!==Infinity);if(pending.length)throw new Error(`Unused network fixtures: ${pending.map(f=>`${f.options.method||"GET"} ${f.origin}${f.options.path} (${f.remaining})`).join(", ")}`);},
  get(origin:string){return {intercept(options:Options){return {reply(status:number,data:ReplyData,extra?:{headers:Record<string,string>}){
    const fixture:Fixture={origin,options,status,data,headers:extra?.headers,remaining:1,delay:0};fixtures.push(fixture);
    const scope={times(n:number){fixture.remaining=n;return scope;},persist(){fixture.remaining=Infinity;return scope;},delay(ms:number){fixture.delay=ms;return scope;}};
    return scope;
  }}}};},
};
