/** Bounded GIF decoding: validate every frame and retain a still without browser/model calls. */
import { rgbaPng } from "./png";

export const MOTION_FRAMES=9;
export const MOTION_SIZE="512x512";
export const MOTION_FRAME_MS=200;
export class InvalidMotionError extends Error { constructor(){super("The animation was incomplete or exceeded the motion limits. A still image will be used instead.");} }
function invalid():never {throw new InvalidMotionError();}

/** GIF LZW, with exact pixel count, dictionary bounds and required end code. */
function indices(data:Uint8Array,min:number,count:number):Uint8Array {
  if(min<2 || min>8)invalid();
  const clear=1<<min,end=clear+1,prefix=new Uint16Array(4096),suffix=new Uint8Array(4096),stack=new Uint8Array(4096),pixels=new Uint8Array(count);
  let bits=min+1,next=end+1,old=-1,first=0,position=0,written=0,cleared=false;
  for(;;){
    if(position+bits>data.length*8)invalid();
    let code=0;for(let n=0;n<bits;n++,position++)code|=((data[position>>>3]!>>>(position&7))&1)<<n;
    if(code===clear){bits=min+1;next=end+1;old=-1;cleared=true;continue;}
    if(!cleared)invalid();
    if(code===end){if(written!==count)invalid();return pixels;}
    const input=code;let top=0;
    if(code===next){if(old<0)invalid();stack[top++]=first;code=old;}
    else if(code>next)invalid();
    while(code>=clear){if(code>=next || top>=4095)invalid();stack[top++]=suffix[code]!;code=prefix[code]!;}
    first=code;stack[top++]=first;
    if(written+top>count)invalid();while(top)pixels[written++]=stack[--top]!;
    if(old>=0 && next<4096){prefix[next]=old;suffix[next]=first;next++;if(next===(1<<bits) && bits<12)bits++;}
    old=input;
  }
}

export interface MotionRaster { bytes:Uint8Array; poster:Uint8Array; width:number; height:number; frames:number }
/** Two finite plays (at most 3.6 seconds); raw provider bytes are retained separately. */
export function prepareMotion(source:Uint8Array):MotionRaster {
  const ascii=(a:number,n:number)=>new TextDecoder().decode(source.subarray(a,a+n));
  if(source.length<14 || source.length>6_000_000 || !["GIF87a","GIF89a"].includes(ascii(0,6)))invalid();
  const view=new DataView(source.buffer,source.byteOffset,source.byteLength),width=view.getUint16(6,true),height=view.getUint16(8,true);
  if(!width || !height || width>512 || height>512)invalid();
  let p=13,global:Uint8Array|undefined;
  const take=(n:number)=>{if(n<0 || p+n>source.length)invalid();const bytes=source.subarray(p,p+n);p+=n;return bytes;};
  if(source[10]!&128)global=take(3*(2<<(source[10]!&7)));
  const header=source.slice(0,p);header.set(new TextEncoder().encode("GIF89a"));
  const loop=new Uint8Array([33,255,11,...new TextEncoder().encode("NETSCAPE2.0"),3,1,1,0,0]);
  const parts:Uint8Array[]=[header,loop],rgba=new Uint8Array(width*height*4);
  let frames=0,gce=0,transparent=0,ended=false;
  const blocks=()=>{const chunks:Uint8Array[]=[];let total=0;for(;;){const n=take(1)[0]!;if(!n)break;const c=take(n);chunks.push(c);total+=n;}const all=new Uint8Array(total);let at=0;for(const c of chunks){all.set(c,at);at+=c.length;}return all;};
  while(p<source.length){
    const start=p,kind=take(1)[0]!;
    if(kind===59){ended=p===source.length;break;}
    if(kind===33){
      const label=take(1)[0]!;
      if(label===249){if(take(1)[0]!==4)invalid();const g=take(4);gce=g[0]!;transparent=g[3]!;if((gce>>>2&7)>3 || gce&0xe0 || take(1)[0]!==0)invalid();}
      else if(label===255){const n=take(1)[0]!;if(n!==11)invalid();const app=new TextDecoder().decode(take(n));blocks();if(!["NETSCAPE2.0","ANIMEXTS1.0"].includes(app))parts.push(source.subarray(start,p));}
      else if(label===254){blocks();parts.push(source.subarray(start,p));}
      else invalid();
      continue;
    }
    if(kind!==44 || ++frames>MOTION_FRAMES)invalid();
    const d=take(9),v=new DataView(d.buffer,d.byteOffset,d.byteLength),x=v.getUint16(0,true),y=v.getUint16(2,true),w=v.getUint16(4,true),h=v.getUint16(6,true),flags=d[8]!;
    if(!w || !h || x+w>width || y+h>height || flags&24)invalid();
    const palette=flags&128 ? take(3*(2<<(flags&7))) : global;if(!palette)invalid();
    const min=take(1)[0]!,pixels=indices(blocks(),min,w*h),colours=palette.length/3;
    if((gce&1) && transparent>=colours || pixels.some(index=>index>=colours))invalid();
    if(frames===1){
      if(!(gce&1) && global){const bg=source[11]!;if(bg>=global.length/3)invalid();for(let i=0;i<rgba.length;i+=4){rgba[i]=global[bg*3]!;rgba[i+1]=global[bg*3+1]!;rgba[i+2]=global[bg*3+2]!;rgba[i+3]=255;}}
      const rows:number[]=[];if(flags&64){for(const [from,step]of [[0,8],[4,8],[2,4],[1,2]])for(let row=from!;row<h;row+=step!)rows.push(row);}else for(let row=0;row<h;row++)rows.push(row);
      for(let i=0;i<pixels.length;i++){const index=pixels[i]!;if((gce&1) && index===transparent)continue;const at=((y+rows[Math.floor(i/w)]!)*width+x+i%w)*4;rgba[at]=palette[index*3]!;rgba[at+1]=palette[index*3+1]!;rgba[at+2]=palette[index*3+2]!;rgba[at+3]=255;}
    }
    parts.push(new Uint8Array([33,249,4,gce,20,0,transparent,0]),source.subarray(start,p));gce=0;transparent=0;
  }
  if(!ended || frames<2)invalid();parts.push(new Uint8Array([59]));
  const bytes=new Uint8Array(parts.reduce((n,c)=>n+c.length,0));if(bytes.length>6_000_000)invalid();let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  return {bytes,poster:rgbaPng(width,height,rgba),width,height,frames};
}

export const supportsMotionModel=(model:string)=>/^gpt-image-2\.6-(?:flare|sunburst)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
export const motionDisabled=(direction:string)=>/\bstill\s+(?:images?\s+)?only\b|\b(?:no|avoid|without)\s+(?:animated\s+)?(?:gifs?|animations?|motion)\b/i.test(direction);
