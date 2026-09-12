/**
 * ファイルの形式を見分ける。拡張子より**中身**を信じる。
 *
 * ★取得したファイルは中身の先頭バイトで拡張子を直す。セッションが切れて
 *   HTMLのログイン画面が「PDF」として保存されても、そのまま結合へ進ませないため。
 * ★判定できないものは**触らない**（推測しない）。結合するときに明示的なエラーになる。
 *
 * 移植元: tenmatsu.py 37-83, 3523-3556, 1521-1531
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */

export const IMAGE_EXTS: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png"]);
export const PDF_EXTS: ReadonlySet<string> = new Set([".pdf"]);
export const EXCEL_EXTS: ReadonlySet<string> = new Set([".xlsx", ".xls", ".xlsm"]);
export const WORD_EXTS: ReadonlySet<string> = new Set([".docx", ".doc", ".docm"]);
export const PPT_EXTS: ReadonlySet<string> = new Set([".pptx", ".ppt", ".pptm"]);
export const MSG_EXTS: ReadonlySet<string> = new Set([".msg"]);
export const TEXT_EXTS: ReadonlySet<string> = new Set([".txt"]);
/**
 * ★動画・音声は紙にできないので**結合せずに飛ばす**（止めない）。
 *   飛ばした名前は記録に残して画面にも出す。中身が紙に載るはずのものを黙って落とさないため。
 */
export const MEDIA_EXTS: ReadonlySet<string> = new Set([
  ".mp4", ".mov", ".avi", ".wmv", ".mkv", ".m4v", ".mpg", ".mpeg", ".webm",
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".wma",
]);

const CONTENT_TYPE_EXT: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "application/x-pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-excel.sheet.macroenabled.12": ".xlsm",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.ms-outlook": ".msg",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/x-ms-wmv": ".wmv",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
};

/**
 * 拡張子（小文字・ドット付き）。無ければ空文字。
 * 先頭がドットだけの名前（".hidden"）は拡張子を持たないとみなす。
 */
export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const at = base.lastIndexOf(".");
  return at > 0 ? base.slice(at).toLowerCase() : "";
}

/** 名前の拡張子を付け替える（無ければ足す） */
export function withExt(name: string, ext: string): string {
  const current = extOf(name);
  return current ? `${name.slice(0, name.length - current.length)}${ext}` : `${name}${ext}`;
}

/** Content-Type から拡張子を引く。`; charset=...` は無視する。引けなければ null */
export function extFromContentType(contentType: string | null | undefined): string | null {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!ct) return null;
  return CONTENT_TYPE_EXT[ct] ?? (ct.includes("pdf") ? ".pdf" : null);
}

export type SniffedExt = ".pdf" | ".jpg" | ".png" | ".mp4" | ".avi" | ".mkv";

const startsWith = (bytes: Uint8Array, sig: readonly number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/**
 * 中身の先頭バイトから形式を判定する。判定できなければ null。
 *
 * ★Office 形式は見ていない（zip の署名を見ない）。`.xlsx` などは表示名の拡張子が頼り。
 * 動画を拾うのは、拡張子が落ちて `.bin` になった添付でも「飛ばす」判断をするため。
 */
export function sniffExtension(bytes: Uint8Array): SniffedExt | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return ".pdf"; // %PDF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ".jpg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return ".mp4"; // ....ftyp (MP4/MOV/M4A)
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x41, 0x56, 0x49, 0x20], 8)) {
    return ".avi"; // RIFF....AVI␠
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return ".mkv"; // Matroska / WebM
  return null;
}

/**
 * 実体に合った拡張子の名前にする。判定できなければ名前はそのまま。
 * `.jpeg` は `.jpg` に書き換えない（同じ形式なので）。
 */
export function fixExtension(name: string, bytes: Uint8Array): string {
  const actual = sniffExtension(bytes);
  if (actual === null) return name;
  const current = extOf(name);
  if (current === actual || (actual === ".jpg" && current === ".jpeg")) return name;
  return withExt(name, actual);
}

/**
 * 先頭がHTMLに見えるか。PDFとして読めなかったときに、原因の見立てを添えるために使う。
 * ★「セッションが切れてログイン画面が保存された」可能性を利用者に伝えられる。
 */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200)).toLowerCase();
  return head.includes("<html") || head.includes("<!doc");
}

export function isMedia(name: string): boolean {
  return MEDIA_EXTS.has(extOf(name));
}
export function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}
export function isPdf(name: string): boolean {
  return PDF_EXTS.has(extOf(name));
}
