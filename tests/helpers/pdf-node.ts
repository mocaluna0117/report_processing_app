// Node上で実PDFからトークンを取り出す (統合テスト・ダンプスクリプト用)。
// Nodeではpdfjsのlegacyビルドを使う (通常ビルドはDOM前提)。
import { readFile } from "node:fs/promises";
import { mapTextItems } from "../../lib/pdf/tokens";
import type { TextToken } from "../../lib/types";

export async function getTokensFromFile(
  path: string,
): Promise<{ tokens: TextToken[]; pageCount: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(path));
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    const tokens: TextToken[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const { height } = page.getViewport({ scale: 1 });
      tokens.push(...mapTextItems(content.items, height, p));
      page.cleanup();
    }
    return { tokens, pageCount: doc.numPages };
  } finally {
    await loadingTask.destroy();
  }
}
