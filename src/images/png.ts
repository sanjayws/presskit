/** Validate a complete raster, not just a PNG header that browsers can partially display. */
import { Unzlib, zlibSync } from "fflate";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function invalid(): never { throw new Error("Incomplete or corrupt PNG"); }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A first-frame still, encoded locally without a second image-model request. */
export function rgbaPng(width:number,height:number,rgba:Uint8Array):Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || width>512 || height>512 || rgba.length!==width*height*4) invalid();
  const rows=new Uint8Array(height*(width*4+1));
  for(let y=0;y<height;y++)rows.set(rgba.subarray(y*width*4,(y+1)*width*4),y*(width*4+1)+1);
  const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=6;
  const chunks=[new Uint8Array([137,80,78,71,13,10,26,10])];
  for(const [name,data]of [["IHDR",header],["IDAT",zlibSync(rows)],["IEND",new Uint8Array()]]as const){
    const chunk=new Uint8Array(data.length+12),v=new DataView(chunk.buffer);v.setUint32(0,data.length);chunk.set(new TextEncoder().encode(name),4);chunk.set(data,8);v.setUint32(chunk.length-4,crc32(chunk.subarray(4,chunk.length-4)));chunks.push(chunk);
  }
  const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return bytes;
}

/** Bounded streaming inflation checks every scanline, filter byte, chunk CRC and zlib checksum. */
export function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 57 || bytes.length > 6_000_000 || ![137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) invalid();
  const width = view.getUint32(16), height = view.getUint32(20), depth = bytes[24]!, colour = bytes[25]!;
  const channels = ({ 0:1, 2:3, 3:1, 4:2, 6:4 } as Record<number,number>)[colour];
  const allowedDepths = colour === 0 ? [1,2,4,8,16] : colour === 3 ? [1,2,4,8] : [8,16];
  if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000 || !channels || !allowedDepths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) invalid();
  const idat: Uint8Array[] = []; let total = 0, ended = false, dataEnded = false, chunks = 0, palette = false;
  for (let p = 8; p + 12 <= bytes.length;) {
    if (++chunks > 4096) invalid();
    const size = view.getUint32(p), kind = view.getUint32(p + 4), end = p + size + 12;
    if (end > bytes.length || crc32(bytes.subarray(p + 4, end - 4)) !== view.getUint32(end - 4)) invalid();
    if (p !== 8 && kind === 0x49484452 || kind === 0x6163544c) invalid(); // duplicate IHDR / APNG
    if (kind === 0x504c5445) {
      if (palette || total || !size || size % 3 || size > 768) invalid();
      palette = true;
    }
    if (kind === 0x49444154) {
      if (dataEnded || colour === 3 && !palette) invalid();
      idat.push(bytes.subarray(p + 8, end - 4)); total += size;
    } else if (total) dataEnded = true;
    if (kind === 0x49454e44) { ended = size === 0 && end === bytes.length; break; }
    // Unknown critical chunks are not valid PNG; ancillary metadata is harmless here.
    if (!(bytes[p + 4]! & 32) && ![0x49484452,0x504c5445,0x49444154].includes(kind)) invalid();
    p = end;
  }
  if (!ended || total < 6) invalid();
  const compressed = new Uint8Array(total); let offset = 0;
  for (const chunk of idat) { compressed.set(chunk, offset); offset += chunk.length; }
  // Adam7 passes reserve only scanline counts, never a full decoded pixel buffer.
  const passes = bytes[28] === 1 ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.flatMap(([x,y,dx,dy]) => {
    const w = Math.max(0, Math.ceil((width - x!) / dx!)), h = Math.max(0, Math.ceil((height - y!) / dy!));
    return w && h ? [{ count:h, bytes:Math.ceil(w * channels * depth / 8) + 1 }] : [];
  });
  let pass = 0, row = 0, position = 0, a = 1, b = 0, complete = false;
  const unzip = new Unzlib((data, final) => {
    for (const byte of data) {
      const current = rows[pass]; if (!current || position === 0 && byte > 4) invalid();
      a = (a + byte) % 65521; b = (b + a) % 65521;
      if (++position === current.bytes) { position = 0; if (++row === current.count) { row = 0; pass++; } }
    }
    complete = final;
  });
  // Small input blocks bound allocations even for highly compressed malicious data.
  for (let p = 0; p < compressed.length; p += 1024) unzip.push(compressed.subarray(p, p + 1024), p + 1024 >= compressed.length);
  const checksum = new DataView(compressed.buffer).getUint32(compressed.length - 4);
  if (!complete || pass !== rows.length || row || position || ((b << 16 | a) >>> 0) !== checksum) invalid();
  return { width, height };
}
