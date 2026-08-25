/**
 * 結合PDFのファイル名を組み立てる。
 * 形式: 「〇〇目点検報告書_施主名様／物件名.pdf」 (例: 1年目点検報告書_山田 太郎様／999.杉並区高円寺北1-2-4Ａ号棟.pdf)
 * - 〇〇 = 点検時期 (1年 / 3ヶ月 など)。抽出できなければ「点検報告書_…」
 * - 施主名は抽出値 (姓と名の間に半角スペース)。抽出できなければファイル名由来の氏名で代替
 * - 区切りは全角スラッシュ (半角 / はパス区切りのため使えない)
 */

/** ファイル名に使えない文字を全角等に置き換える */
function sanitizeForFileName(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\//g, "／")
    .replace(/\\/g, "＼")
    .replace(/:/g, "：")
    .replace(/\*/g, "＊")
    .replace(/\?/g, "？")
    .replace(/"/g, "”")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\|/g, "｜")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

export function buildMergedPdfName(opts: {
  /** 点検時期の抽出値 (例: 1年, 3ヶ月) */
  timing?: string;
  /** 施主名の抽出値 (例: 山田 太郎) */
  ownerName?: string;
  /** 物件名称の抽出値 */
  propertyName?: string;
  /** 抽出失敗時に使うファイル名由来の氏名 */
  fallbackOwner?: string;
}): string {
  const timing = sanitizeForFileName(opts.timing ?? "");
  const owner = sanitizeForFileName(opts.ownerName || opts.fallbackOwner || "");
  const property = sanitizeForFileName(opts.propertyName ?? "");

  const prefix = timing ? `${timing}目点検報告書` : "点検報告書";
  const ownerPart = owner ? `${owner}様` : "施主不明";
  const propertyPart = property ? `／${property}` : "";

  return `${prefix}_${ownerPart}${propertyPart}.pdf`;
}
