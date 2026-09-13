"use client";

// PDFのページを画面に出すための絵（JPEG の data URL）にする。
// 結合PDF（写真報告書＋点検報告書）と完了報告書のプレビューで使う。
//
// ★pdf.js は渡したバイト列を worker へ転送して手放す（detach）ので、呼ぶ側は必ず写しを渡す。
//   ここでは受け取ったバイト列をそのまま使わず、1回ごとにコピーしてから開く。
// ★描くのは一度に1つだけ（worker は1本）。表の行が多くても画面が固まらないように順番待ちにする。
import { loadPdfjs } from "./extract";

export interface RenderedPdfPage {
  /** JPEG の data URL */
  src: string;
  /** 描いた絵の実寸（px）。縦横比をそのまま出すのに使う */
  width: number;
  height: number;
}

export interface RenderedPdf {
  pages: RenderedPdfPage[];
  /** PDF全体のページ数（maxPages で打ち切っても本当の数を返す） */
  total: number;
}

/** 1ページの描画に使う倍率の上限（写真入りのPDFで画像が大きくなりすぎないように） */
const MAX_SCALE = 3;

/** 順番待ちの列。描き終わるまで次を始めない */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  // 失敗しても列は止めない（次の描画は行う）
  queue = next.catch(() => undefined);
  return next;
}

async function render(bytes: Uint8Array, width: number, maxPages: number): Promise<RenderedPdf> {
  const pdfjs = await loadPdfjs();
  // ★worker に手放されるので写しを渡す（呼び出し元のバイト列を壊さない）
  const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await loadingTask.promise;
  const pages: RenderedPdfPage[] = [];
  try {
    const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_SCALE, ((width * dpr) / base.width) || 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      await page.render({ canvas, viewport }).promise;
      pages.push({ src: canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height });
      // すぐに捨てる（写真入りのPDFではページごとに数十MBになる）
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
    return { pages, total: doc.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * PDFの先頭から maxPages ページを絵にする。
 * width は画面に出す幅（CSS px）で、端末の解像度に合わせて実寸を決める。
 */
export function renderPdfPages(
  bytes: Uint8Array,
  opts: { width: number; maxPages?: number },
): Promise<RenderedPdf> {
  return enqueue(() => render(bytes, opts.width, opts.maxPages ?? 50));
}
