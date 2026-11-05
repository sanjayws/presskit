import {zlibSync} from "fflate";
/** Valid compressed PNG fixture, with the exact requested raster dimensions. */
export function png(width:number,height:number,raster=new Uint8Array(height*(width*3+1)),corruptChecksum=false):Uint8Array {
  const bytes:number[]=[137,80,78,71,13,10,26,10];
  function chunk(type:string,data:Uint8Array){const payload=new Uint8Array(4+data.length);payload.set(new TextEncoder().encode(type));payload.set(data,4);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let n=0;n<8;n++)crc=crc&1 ? 0xedb88320^(crc>>>1) : crc>>>1;}crc=(crc^0xffffffff)>>>0;const append=(n:number)=>bytes.push(n>>>24&255,n>>>16&255,n>>>8&255,n&255);append(data.length);for(const byte of payload)bytes.push(byte);append(crc);}
  const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
  const compressed=zlibSync(raster);if(corruptChecksum)compressed[compressed.length-1]=compressed[compressed.length-1]!^1;
  chunk("IHDR",header);chunk("IDAT",compressed);chunk("IEND",new Uint8Array());return new Uint8Array(bytes);
}
