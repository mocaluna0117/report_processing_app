import { Zip, ZipPassThrough } from "fflate";

/**
 * 結合PDF群をZIPにまとめる。
 * PDFの再圧縮は効果がほぼ無いので無圧縮 (ZipPassThrough)。
 * fflateは非ASCIIファイル名にUTF-8フラグ (EFS bit) を立てるためWindowsでも文字化けしない。
 */
export async function zipFiles(
  entries: { name: string; data: Uint8Array }[],
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: BlobPart[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      chunks.push(chunk.slice() as BlobPart);
      if (final) resolve(new Blob(chunks, { type: "application/zip" }));
    });
    for (const e of entries) {
      const file = new ZipPassThrough(e.name);
      zip.add(file);
      file.push(e.data, true);
    }
    zip.end();
  });
}
