"use client";

/**
 * 生成したファイルをブラウザに保存させる。
 * Blob の生成 (と TypeScript の BlobPart 変換) をここに閉じ込める。
 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // クリック直後に revoke するとSafariで保存に失敗することがあるので少し置く
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBytes(bytes: Uint8Array, name: string, mime: string): void {
  downloadBlob(new Blob([bytes as unknown as BlobPart], { type: mime }), name);
}
