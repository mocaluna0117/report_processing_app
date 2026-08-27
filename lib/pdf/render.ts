"use client";

// 点検報告書 (手書きチェックシートの写真) を画像認識用のJPEGにする。
import type { TextToken } from "@/lib/types";
import { loadPdfjs } from "./extract";
import { isPhoneToken } from "./parse-inspection-report";
import { mapTextItems } from "./tokens";

/** 署名ブロック (個人情報) の位置を示すテキスト層のトークン (電話番号は全角ハイフン表記も含めて判定) */
const SIGNATURE_TOKEN = /署名|承諾/;
const isPiiToken = (s: string) => isPhoneToken(s) || SIGNATURE_TOKEN.test(s);
/** 電話番号行の上にある「確認・承諾」2行分の高さ (pt)。見本5件で実測 */
const SIGNATURE_BLOCK_MARGIN_PT = 50;
/** 署名ブロックを検出できない場合の切り抜き位置 (ページ高さ比)。見本5件で実測した上端位置 */
const FALLBACK_CROP_RATIO = 0.82;

export interface RenderedInspection {
  /** JPEG (base64、data:プレフィックス無し) */
  images: string[];
  warnings: string[];
  /** 描画したページのテキスト層トークン (連絡先の抽出に使う。外部には送らない) */
  tokens: TextToken[];
}

/**
 * 点検報告書の各ページを、下部の署名・電話番号ブロックを切り落とした JPEG にする。
 * 個人情報を外部 (Gemini) へ送らないための切り抜き。チェックシート本体 (項目・有無の丸・
 * 点検員のメモ) だけが残る。
 * 注意: pdfjs は bytes を worker へ transfer して detach するため、呼び出し側はコピーを渡すこと。
 */
export async function renderInspectionPages(
  bytes: Uint8Array,
  opts: { scale?: number; maxPages?: number } = {},
): Promise<RenderedInspection> {
  const scale = opts.scale ?? 2; // A4 で幅 約1190px。手書きの丸が判読できる解像度
  const maxPages = opts.maxPages ?? 2;
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;
  const images: string[] = [];
  const warnings: string[] = [];
  const tokens: TextToken[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const pageTokens = mapTextItems((await page.getTextContent()).items, base.height, p);
      tokens.push(...pageTokens);
      const piiYs = pageTokens.filter((t) => isPiiToken(t.str)).map((t) => t.y);

      let cropPt: number;
      if (piiYs.length > 0) {
        cropPt = Math.min(...piiYs) - SIGNATURE_BLOCK_MARGIN_PT;
      } else {
        cropPt = base.height * FALLBACK_CROP_RATIO;
        warnings.push(
          `点検報告書${doc.numPages > 1 ? ` ${p}ページ目` : ""}: 署名欄の位置を検出できなかったため既定位置で切り抜きました`,
        );
      }
      cropPt = Math.max(base.height * 0.3, Math.min(base.height, cropPt));

      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      // キャンバスを切り抜き位置までの高さにすると、それより下 (署名・電話番号) は描画されない
      canvas.height = Math.ceil(cropPt * scale);
      await page.render({ canvas, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      images.push(dataUrl.slice(dataUrl.indexOf(",") + 1));
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { images, warnings, tokens };
}
