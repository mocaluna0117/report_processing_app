"use client";

// pdfjs-dist はDOM依存があるため必ずクライアント側でのみ動的importする。
// worker は postinstall で public/ へコピーした固定パスを使う
// (バンドラ経由のworker解決は壊れやすい。fake workerフォールバックはUIフリーズの原因)。
import type { TextToken } from "@/lib/types";
import { mapTextItems } from "./tokens";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * PDFの全ページからテキストトークンを抽出する。
 * 注意: pdfjsはbytesをworkerへtransferしdetachするため、呼び出し側は必ずコピーを渡すこと
 * (原本はpdf-lib結合用に温存する)。page.renderは呼ばないので巨大な埋め込み写真でも軽い。
 */
export async function extractTokens(
  bytes: Uint8Array,
): Promise<{ tokens: TextToken[]; pageCount: number }> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: bytes });
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
