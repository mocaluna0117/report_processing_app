/**
 * 画像（JPEG / PNG）を1ページの PDF にする。
 *
 * 移植元: tenmatsu.py 1051-1087（image_to_pdf_bytes）
 *
 * 規則は移植元と同じ（`lib/tenmatsu/preview.ts` の imagePageBox）:
 *   - A4、余白 10mm。**横長の画像は用紙も横向き**にする（図面・写真が小さくなりすぎないように）
 *   - 縦横比を保って余白の内側いっぱいに拡大・縮小し、中央に置く
 *   - ★スマホ写真の **EXIF の向きを反映する**。移植元の Pillow（exif_transpose）と違い、pdf-lib は
 *     向きを見ないので、ここで読んで回す。やらないと横倒しの写真が報告書に入る
 * ※移植元は用紙の大きさ（72dpi）まで画素を減らしていた。こちらは元の画素のまま埋め込むので、文字の読める写真になる。
 */
import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { imagePageBox } from "@/lib/tenmatsu/preview";

export type ImageKind = "jpeg" | "png";

export function imageKindOf(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "png";
  return null;
}

/**
 * JPEG の EXIF の向き（1〜8）。無い・読めないときは 1（そのまま）。
 * ★読めないときに推測で回さない。
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    // 画像の本体（SOS）より後に EXIF は無い
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = view.getUint16(offset + 2);
    if (length < 2) return 1;
    const start = offset + 4;
    if (marker === 0xe1 && start + 14 <= bytes.length && String.fromCharCode(...bytes.subarray(start, start + 6)) === "Exif\0\0") {
      return readTiffOrientation(view, start + 6, Math.min(bytes.length, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return 1;
}

function readTiffOrientation(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const order = view.getUint16(tiff);
  const little = order === 0x4949; // "II"
  if (!little && order !== 0x4d4d) return 1; // "MM"
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * 画像の保存されている向きから、見た目の向きに置くための変換（PDF の cm 行列）。
 * 画像は (0,0)-(1,1) の正方形に描かれるので、それを表示枠 (x, y, 幅 w, 高さ h) に写す。
 */
export function orientationMatrix(
  orientation: number,
  box: { x: number; y: number; w: number; h: number },
): [number, number, number, number, number, number] {
  const { x, y, w, h } = box;
  switch (orientation) {
    case 2: // 左右反転
      return [-w, 0, 0, h, x + w, y];
    case 3: // 180度
      return [-w, 0, 0, -h, x + w, y + h];
    case 4: // 上下反転
      return [w, 0, 0, -h, x, y + h];
    case 5: // 左右反転して反時計回りに90度（転置）
      return [0, -h, -w, 0, x + w, y + h];
    case 6: // 時計回りに90度
      return [0, -h, w, 0, x, y + h];
    case 7: // 左右反転して時計回りに90度
      return [0, h, w, 0, x, y];
    case 8: // 反時計回りに90度
      return [0, h, -w, 0, x + w, y];
    default:
      return [w, 0, 0, h, x, y];
  }
}

/** 画像を1ページの PDF にする。画像として読めなければ例外（呼ぶ側が「結合できなかった」として扱う） */
export async function imageToPdfBytes(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const kind = imageKindOf(bytes);
  if (!kind) throw new Error(`画像として読めませんでした: ${name}`);
  const doc = await PDFDocument.create();
  let image;
  try {
    image = kind === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch (e) {
    throw new Error(`画像として読めませんでした: ${name}（${e instanceof Error ? e.message.split("\n")[0] : "形が不正"}）`);
  }
  const orientation = kind === "jpeg" ? jpegOrientation(bytes) : 1;
  // 5〜8 は縦横が入れ替わって見える
  const sideways = orientation >= 5;
  const shownWidth = sideways ? image.height : image.width;
  const shownHeight = sideways ? image.width : image.height;
  const box = imagePageBox(shownWidth, shownHeight);
  const page = doc.addPage([box.pageWidth, box.pageHeight]);
  const key = page.node.newXObject("Image", image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...orientationMatrix(orientation, { x: box.x, y: box.y, w: box.drawWidth, h: box.drawHeight })),
    drawObject(key),
    popGraphicsState(),
  );
  return await doc.save();
}
