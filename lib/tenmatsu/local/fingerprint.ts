/**
 * 保存したPDFの「中身の指紋」（SHA-256 と大きさ）。
 *
 * ★記録（_記録/processed*.json）とPDFをファイル名だけで結んでいると、利用者がPCで名前を変えただけで
 *   「ファイルなし」になり、差し替えが元の名前で別のファイルを作ってしまう。
 *   中身の指紋も残しておき、名前で見つからないときは中身が同じPDFを探して結び直す（relink.ts）。
 * ★指紋は「いま書いたバイト列」からだけ作る。前の記録から写さない（中身が変われば指紋も変わるため）。
 */
import type { FolderStore } from "./fs";

export interface PdfFingerprint {
  pdf_size: number;
  pdf_sha256: string;
}

const HEX = /^[0-9a-f]{64}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintOf(bytes: Uint8Array): Promise<PdfFingerprint> {
  return { pdf_size: bytes.byteLength, pdf_sha256: await sha256Hex(bytes) };
}

/** 記録に入っている指紋。形が正しくなければ null（手で書き換えられた値を信じない） */
export function readFingerprint(entry: Record<string, unknown> | undefined | null): PdfFingerprint | null {
  if (!entry) return null;
  const size = entry.pdf_size;
  const sha = entry.pdf_sha256;
  if (typeof sha !== "string" || !HEX.test(sha)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  return { pdf_size: size, pdf_sha256: sha };
}

/**
 * ファイル名を比べるための鍵。★macOS と Windows は大文字と小文字を区別せず、
 * Finder は濁点を分けた形（NFD）で名前を返すことがあるので、揃えてから比べる。
 */
export const nameKey = (name: string): string => name.normalize("NFC").toLowerCase();

/** 1回の一覧の中でハッシュを取り直さないための覚え書き（名前｜大きさ｜更新日時で覚える） */
export interface HashMemo {
  hash(store: FolderStore, file: { name: string; size: number; lastModified: number }): Promise<string>;
}

export function createHashMemo(max = 1000): HashMemo {
  const memo = new Map<string, string>();
  return {
    async hash(store, file) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      const found = memo.get(key);
      if (found) return found;
      const bytes = await store.readBytes([file.name]);
      const sha = await sha256Hex(bytes);
      // 読んでいる間に書き換わっていたら覚えない（次に読むときに取り直す）
      if (bytes.byteLength === file.size) {
        if (memo.size >= max) {
          const oldest = memo.keys().next();
          if (!oldest.done) memo.delete(oldest.value);
        }
        memo.set(key, sha);
      }
      return sha;
    },
  };
}
