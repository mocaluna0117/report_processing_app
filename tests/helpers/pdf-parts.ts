import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

/**
 * 結合の検証に使う部品（その場で作る・中身は架空）。
 * PDF は**ページの大きさ**で見分ける（文字を読まずに並び順を確かめられる）。
 */
export async function makePdf(pages: number, size: [number, number] = [595, 842]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  return await doc.save();
}

/** 結合した PDF のページの大きさ（整数に丸める） */
export async function pageSizes(bytes: Uint8Array): Promise<[number, number][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
}

/**
 * EXIF の向きを持つ JPEG の形だけのバイト列（画素は入っていない）。
 * pdf-lib は JPEG を解かずに埋め込むので、SOF の縦横が正しければ PDF にできる。
 */
export function makeJpeg(width: number, height: number, orientation?: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const tiff = [
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM" 42, IFD0 は 8 バイト目
      0x00, 0x01, // 項目は1つ
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // 向き（SHORT）
      0x00, 0x00, 0x00, 0x00, // 次の IFD は無い
    ];
    const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
    const length = payload.length + 2;
    bytes.push(0xff, 0xe1, length >> 8, length & 0xff, ...payload);
  }
  bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03);
  bytes.push(0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 本物の PNG（白一色・RGB） */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 3 + 1) * height).fill(255);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0; // 各行の先頭はフィルター種別
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 暗号化された（パスワード付きの）PDF の形 */
export function makeEncryptedPdf(): Uint8Array {
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >> endobj",
    "4 0 obj << /Filter /Standard /V 1 /R 2 /O (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /U (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /P -4 >> endobj",
  ].join("\n");
  const trailer = "\ntrailer << /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\n%%EOF\n";
  return new TextEncoder().encode(body + trailer);
}
