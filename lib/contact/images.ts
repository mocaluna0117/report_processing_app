/**
 * 問い合わせに付ける写真の小さな規則。純関数のみ。
 * ★種類は拡張子や Content-Type を信じず、先頭のバイトで見分ける（サーバーで必ず通す）。
 */

export type ContactImageType = "image/png" | "image/jpeg" | "image/webp";

/** 先頭のバイトで種類を見分ける。写真として受け付けないものは null */
export function imageKind(bytes: Uint8Array): ContactImageType | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(at(0), at(1), at(2), at(3)) === "RIFF" &&
    String.fromCharCode(at(8), at(9), at(10), at(11)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export const IMAGE_EXTENSION: Record<ContactImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 長い辺が max に収まる大きさ（大きくはしない） */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return { width: Math.round(width), height: Math.round(height) };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
