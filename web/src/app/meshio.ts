// 外壳导出（P1-08）：二进制 STL、3MF（zip 里一份 XML）。3MF 的 zip 自己打（只用"存储"不压缩），
// 不引 zip 依赖：三个小文件，CRC32 + 本地头 + 中央目录 + 结束记录就够切片软件和 three.js 3MFLoader 读。
import type { MeshData } from './enclosure.ts';

export interface NamedMesh {
  name: string;
  mesh: MeshData;
}

/** 二进制 STL：80 字节头 + 三角形数 + 每个三角形 50 字节（法线、三个顶点、属性） */
export function toStl(objs: NamedMesh[], header = 'TryBoard enclosure'): Uint8Array {
  const n = objs.reduce((a, o) => a + o.mesh.idx.length / 3, 0);
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(header.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(head);
  dv.setUint32(80, n, true);
  let o = 84;
  for (const { mesh } of objs) {
    const P = mesh.pos;
    for (let t = 0; t < mesh.idx.length; t += 3) {
      const a = mesh.idx[t] * 3, b = mesh.idx[t + 1] * 3, c = mesh.idx[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (const v of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) {
        dv.setFloat32(o, v, true);
        o += 4;
      }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** 0.001 mm 精度，去掉尾零 */
const num = (v: number) => {
  const s = v.toFixed(3);
  return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

export function modelXml(objs: NamedMesh[], title: string): string {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<metadata name="Title">${xmlEsc(title)}</metadata>\n<metadata name="Application">TryBoard</metadata>\n<resources>\n`);
  objs.forEach((o, i) => {
    parts.push(`<object id="${i + 1}" name="${xmlEsc(o.name)}" type="model"><mesh><vertices>\n`);
    const P = o.mesh.pos;
    const vs: string[] = [];
    for (let k = 0; k < P.length; k += 3) vs.push(`<vertex x="${num(P[k])}" y="${num(P[k + 1])}" z="${num(P[k + 2])}"/>`);
    parts.push(vs.join('\n'), '\n</vertices><triangles>\n');
    const ts: string[] = [];
    const I = o.mesh.idx;
    for (let k = 0; k < I.length; k += 3) ts.push(`<triangle v1="${I[k]}" v2="${I[k + 1]}" v3="${I[k + 2]}"/>`);
    parts.push(ts.join('\n'), '\n</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n', objs.map((_, i) => `<item objectid="${i + 1}"/>`).join('\n'), '\n</build>\n</model>\n');
  return parts.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n`;

export function to3mf(objs: NamedMesh[], title = 'TryBoard enclosure'): Uint8Array {
  const enc = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: '3D/3dmodel.model', data: enc.encode(modelXml(objs, title)) },
  ]);
}

let crcTable: Uint32Array | null = null;
export function crc32(d: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 最小 zip：只存储（method 0），文件名 UTF-8（通用位 11），固定时间 1980-01-01 */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, off, true);
  const all = [...locals, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}
