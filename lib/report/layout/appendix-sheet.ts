/**
 * 別紙のレイアウト (テンプレートの sheet4)。印刷倍率85%。
 * 1枠 = 「項目行 + (補足がある枠だけ細い欄) + 対応結果行」。
 * 補足の無い枠だけなら今までどおり12枠で、13件以上ある場合はページを分けて 2/3・3/3 … と続ける。
 */
import { APPENDIX_SHEET_METRICS } from "@/lib/report/metrics";
import type { AppendixItem } from "@/lib/report/model";
import type { CellSpec, SheetSpec, Sides } from "@/lib/report/layout/grid";

/** 別紙の項目枠の数 (補足が無いときの1ページ分) */
export const APPENDIX_ROWS_PER_PAGE = 12;

/** 見出し (1〜5行目) の行高 */
const HEADER_ROW_HEIGHTS = APPENDIX_SHEET_METRICS.rowHeights.slice(0, 5);
/** 枠の行高 (Excelの行高。PDFは印刷倍率85%を掛けて描く)。xlsx側もこれに合わせる */
export const APPENDIX_ROW_HEIGHTS = { item: 18, supplement: 15, result: 39.75 } as const;
const ITEM_ROW_HEIGHT = APPENDIX_ROW_HEIGHTS.item;
/** 補足の細い欄 (項目行の下) */
const SUPPLEMENT_ROW_HEIGHT = APPENDIX_ROW_HEIGHTS.supplement;
const RESULT_ROW_HEIGHT = APPENDIX_ROW_HEIGHTS.result;
/** 補足の無い枠1つ分の高さ */
const SLOT_HEIGHT = ITEM_ROW_HEIGHT + RESULT_ROW_HEIGHT;
/** 1ページに置ける枠の高さの合計 (今までの12枠と同じ。これを超えたら次のページへ) */
const PAGE_SLOT_HEIGHT = APPENDIX_ROWS_PER_PAGE * SLOT_HEIGHT;

const BOX: Sides = { l: "thin", r: "thin", t: "thin", b: "thin" };
/** 項目行と対応結果行の間は細い破線ではなく極細の実線 */
const ITEM_ROW: Sides = { l: "thin", r: "thin", t: "thin", b: "hair" };
/** 補足の欄は上下を極細の実線で挟む (項目行の下・対応結果行の上と同じ) */
const SUPPLEMENT_ROW: Sides = { l: "thin", r: "thin", b: "hair" };
const RESULT_ROW: Sides = { l: "thin", r: "thin", b: "thin" };

export interface AppendixPageInput {
  title: string;
  propertyLine: string;
  ownerLine: string;
  /** このページに載せる項目 */
  items: AppendixItem[];
  pageLabel: string;
}

/** その項目が使う高さ (補足があれば細い欄の分だけ高くなる) */
function heightOf(item: AppendixItem): number {
  return SLOT_HEIGHT + (item.supplement ? SUPPLEMENT_ROW_HEIGHT : 0);
}

/**
 * 1ページ分の枠。項目のあとは、ページの残りが埋まるまで空の枠を並べる
 * (今までの別紙と同じ見た目にするため)。PDFもxlsxもこれで枠を作る。
 */
export function appendixSlots(items: readonly AppendixItem[]): AppendixItem[] {
  const slots: AppendixItem[] = [...items];
  let used = slots.reduce((sum, item) => sum + heightOf(item), 0);
  while (used + SLOT_HEIGHT <= PAGE_SLOT_HEIGHT + 0.01) {
    slots.push({ text: "", supplement: "" });
    used += SLOT_HEIGHT;
  }
  return slots;
}

export function appendixSheet(input: AppendixPageInput): {
  spec: SheetSpec;
  values: Record<string, string>;
} {
  const cells: CellSpec[] = [
    { ref: "A1", text: "（別　紙）", size: 14, bold: true, v: "center" },
    { ref: "B1", text: input.pageLabel, size: 11, h: "right", v: "center" },
    { ref: "A2", field: "propertyLine", size: 11, v: "center", shrink: true },
    { ref: "A3", field: "ownerLine", size: 11, v: "center", shrink: true },
    { ref: "A4", field: "title", size: 14, bold: true, v: "center" },
    {
      ref: "A5",
      text: "項　　　目",
      size: 11,
      h: "center",
      v: "center",
      border: BOX,
      fill: APPENDIX_SHEET_METRICS.headerFill,
    },
    {
      ref: "B5",
      text: "チェック欄",
      size: 11,
      v: "center",
      border: BOX,
      fill: APPENDIX_SHEET_METRICS.headerFill,
    },
  ];

  const values: Record<string, string> = {
    title: input.title,
    propertyLine: input.propertyLine,
    ownerLine: input.ownerLine,
  };

  const slots = appendixSlots(input.items);

  const rowHeights = [...HEADER_ROW_HEIGHTS];
  let row = 6;
  slots.forEach((item, k) => {
    const itemRow = row;
    values[`item${k}`] = item.text;
    cells.push({
      ref: `A${itemRow}`,
      field: `item${k}`,
      size: 11,
      v: "center",
      border: ITEM_ROW,
      shrink: true,
    });
    rowHeights.push(ITEM_ROW_HEIGHT);
    row++;

    if (item.supplement) {
      values[`supplement${k}`] = item.supplement;
      cells.push({
        ref: `A${row}`,
        field: `supplement${k}`,
        size: 11,
        v: "center",
        border: SUPPLEMENT_ROW,
        shrink: true,
      });
      rowHeights.push(SUPPLEMENT_ROW_HEIGHT);
      row++;
    }

    cells.push({
      ref: `A${row}`,
      // 対応結果の見出しは項目がある枠だけ (見本の別紙と同じ)
      text: item.text ? "対応結果：" : "",
      size: 11,
      v: "center",
      border: RESULT_ROW,
    });
    rowHeights.push(RESULT_ROW_HEIGHT);
    // チェック欄は枠の全部の行にまたがる (結合セル)
    cells.push({ ref: `B${itemRow}:B${row}`, border: BOX });
    row++;
  });

  return {
    spec: {
      scale: APPENDIX_SHEET_METRICS.scale,
      originColumn: "A",
      x0: APPENDIX_SHEET_METRICS.x0,
      y0: APPENDIX_SHEET_METRICS.y0,
      colChars: APPENDIX_SHEET_METRICS.colChars,
      rowHeights,
      cells,
    },
    values,
  };
}

/**
 * 項目をページごとに分ける。
 * 1ページの枠の高さの合計 (補足が無ければ12枠分) を上限に上から詰める。
 */
export function paginateAppendixItems(items: readonly AppendixItem[]): AppendixItem[][] {
  if (items.length === 0) return [[]];
  const pages: AppendixItem[][] = [];
  let page: AppendixItem[] = [];
  let used = 0;
  for (const item of items) {
    const height = heightOf(item);
    if (page.length > 0 && used + height > PAGE_SLOT_HEIGHT + 0.01) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(item);
    used += height;
  }
  pages.push(page);
  return pages;
}
