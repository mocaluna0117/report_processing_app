/**
 * 完了報告書PDFの寸法。すべて pt・左上原点 (y は下向き)。
 *
 * Excelの行高・列幅から算出したうえで、見本PDF (完了報告書_例/*.pdf) の実測値に合わせて
 * 較正した定数を使う。Excelの印刷はピクセル丸めの影響で pt 換算どおりにならないため、
 * 「Excelの寸法 × PRINT_FACTOR」という形で近似している (誤差は 0.2pt 以内)。
 * 数値の根拠は tests/report-geometry.json (見本PDFから抽出した罫線・文字位置) にある。
 */

/** A4 縦 */
export const PAGE_WIDTH = 595.32;
export const PAGE_HEIGHT = 841.92;

/** Excelの寸法 → 印刷結果の伸び。見本PDFの罫線間隔から算出 */
export const PRINT_FACTOR = 1.02682;
/** Excelの列幅1文字分の pt。幅4の列が 24.485pt になる値 */
export const COL_CHAR_UNIT = 5.9615;

/** 下寄せセルのベースライン: 行の下端からこれだけ上 */
export const BASELINE_FROM_BOTTOM = 5.9;
/** 下罫線が medium / double のときはベースラインがさらに上がる */
export const BASELINE_BORDER_LIFT = 1.1;
/** 上下中央のセルのベースライン: 行の中心 + 文字サイズ × これ */
export const BASELINE_CENTER_RATIO = 0.34;
/** セル内の左右の余白 */
export const PAD_LEFT = 2.04;
export const PAD_RIGHT = 2.14;

/** 罫線の太さ (縮小率を掛ける前) */
export const LINE_WIDTH = { thin: 0.96, medium: 1.92, hair: 0.12, double: 0.96 } as const;
/** 二重線の2本の間隔 (中心から ±半分) */
export const DOUBLE_GAP = 1.92;

/** チェックボックス: 一辺の長さ / 右寄せセルでの右端からの距離 / ベースラインの位置 */
export const CHECKBOX = {
  size: 11.04,
  rightInset: 2.65,
  /** 下寄せ (立会・受付項目): 行の下端からベースラインまで */
  baselineFromBottom: 3.05,
  /** 上下中央 (完了チェック): 行の中心から箱の中心までのずれ */
  centerOffset: 1.08,
  /** 中央寄せのときの箱の中心の左へのずれ (見本の実測) */
  centerShift: 0.58,
} as const;

/** 文字を縮小する下限 (これ以下にはせず、はみ出す分はセルで切る) */
export const MIN_FONT_SIZE = 7;

/**
 * Excelは文字サイズを 1/600 インチ (0.12pt) 刻みに丸めて印刷する。
 * 見本PDFの実測 (11pt→11.04 / 14pt→14.04 / 10pt→9.96 / 別紙の11pt×85%→9.36) と一致する。
 * 行の高さと違い、文字サイズには印刷倍率 (PRINT_FACTOR) がかからない。
 */
export function quantizeFontSize(pt: number): number {
  return Math.round(pt / 0.12) * 0.12;
}

/** 本紙 (作業報告書　兼　完了報告書) */
export const MAIN_SHEET_METRICS = {
  scale: 1,
  x0: 51.48,
  y0: 39.99,
  /** B〜U の20列。Excelの列幅は全て4文字 */
  colChars: Array.from({ length: 20 }, () => 4),
  /** 1行目から33行目までの行高 (pt)。既定は18 */
  rowHeights: [
    18, 18, 18, 10.5, 25, 25, 25, 25, 25, 13.5, 25, 25, 25, 9.75, 25, 25, 25, 25, 25, 25, 12.75,
    25, 25, 25, 25, 25, 25, 9, 38.25, 8.25, 25, 25, 35.25,
  ],
  /** ページヘッダー (シート名を太字14で左上に印刷する設定) */
  header: { text: "作業報告書　兼　完了報告書", size: 14.04, x: 51.96, baseline: 39.6 },
} as const;

/** 別紙 (印刷倍率85%) */
export const APPENDIX_SHEET_METRICS = {
  scale: 0.85,
  x0: 51.54,
  y0: 54.16,
  /** A列 (項目) と B列 (チェック欄) */
  colChars: [83.33203125, 11],
  /** 1〜5行 + (項目行, 対応結果行) × 12 */
  rowHeights: [22.5, 18, 18, 25.5, 18, ...Array.from({ length: 12 }, () => [18, 39.75]).flat()],
  /** 見出し行の塗り (テーマ accent1 の明るさ60%) */
  headerFill: "#BDD7EE",
} as const;
