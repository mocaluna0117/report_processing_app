"use client";

// pdfjs-dist はDOM依存があるため必ずクライアント側でのみ動的importする。
// worker は postinstall で public/ へコピーした固定パスを使う
// (バンドラ経由のworker解決は壊れやすい。fake workerフォールバックはUIフリーズの原因)。
import type { TextToken } from "@/lib/types";
import { mapTextItems } from "./tokens";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export async function loadPdfjs() {
  if (!pdfjsPromise) {
    const p = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
    // 失敗はキャッシュしない (一時的な読み込み失敗でセッション中ずっと使えなくなるのを防ぐ)
    pdfjsPromise = p.catch((e) => {
      if (pdfjsPromise === p) pdfjsPromise = null;
      throw e;
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

/**
 * pdfjs と worker を先読みする。初回処理時の worker 起動待ち (数百ms〜) を
 * ページ表示中に済ませておくため、UIのマウント時に呼ぶ。
 */
export function warmUpPdfjs(): void {
  void loadPdfjs().catch(() => {
    // 先読みの失敗は無視してよい。loadPdfjs は失敗をキャッシュしないので、
    // 実処理時に再度読み込まれ、そこで初めてエラーとして扱われる
  });
}
