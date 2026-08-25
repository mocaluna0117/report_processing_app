import { PDFDocument, degrees } from "pdf-lib";

export interface MergeResult {
  bytes: Uint8Array;
  warnings: string[];
}

async function loadDoc(
  bytes: Uint8Array,
  label: string,
): Promise<{ doc: PDFDocument; warning: string | null }> {
  try {
    return { doc: await PDFDocument.load(bytes, { updateMetadata: false }), warning: null };
  } catch {
    // スキャナ製PDFには空パスワード暗号化や壊れたxrefを持つものがある。
    // pdf-libは復号できないため、強制読み込みした場合は内容が壊れている可能性を警告する。
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return {
      doc,
      warning: `${label}は暗号化または破損の可能性があるため強制読み込みしました。結合PDFのページが正しく表示されるか確認してください`,
    };
  }
}

/** 写真報告書 → 点検報告書 の順に全ページを結合する */
export async function mergeReports(
  photoBytes: Uint8Array,
  inspectionBytes: Uint8Array,
): Promise<MergeResult> {
  const out = await PDFDocument.create();
  const warnings: string[] = [];
  const sources: [Uint8Array, string][] = [
    [photoBytes, "写真報告書"],
    [inspectionBytes, "点検報告書"],
  ];
  for (const [bytes, label] of sources) {
    const { doc: src, warning } = await loadDoc(bytes, label);
    if (warning) warnings.push(warning);
    const copied = await out.copyPages(src, src.getPageIndices());
    const srcPages = src.getPages();
    copied.forEach((page, i) => {
      // copyPagesは通常/Rotateを保持するが、継承値の取りこぼしに備えて明示的に再設定
      page.setRotation(degrees(srcPages[i].getRotation().angle));
      out.addPage(page);
    });
  }
  return { bytes: await out.save(), warnings };
}
