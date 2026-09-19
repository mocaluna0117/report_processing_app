/**
 * 別紙のレイアウト (テンプレートの sheet4)。印刷倍率85%。
 * 項目は12枠。13件以上ある場合はページを分けて 2/3・3/3 … と続ける。
 */
import { APPENDIX_SHEET_METRICS } from "@/lib/report/metrics";
import type { CellSpec, SheetSpec, Sides } from "@/lib/report/layout/grid";

/** 別紙の項目枠の数 (1ページ分) */
export const APPENDIX_ROWS_PER_PAGE = 12;

const BOX: Sides = { l: "thin", r: "thin", t: "thin", b: "thin" };
/** 項目行と対応結果行の間は細い破線ではなく極細の実線 */
const ITEM_ROW: Sides = { l: "thin", r: "thin", t: "thin", b: "hair" };
const RESULT_ROW: Sides = { l: "thin", r: "thin", b: "thin" };

export interface AppendixPageInput {
  title: string;
  propertyLine: string;
  ownerLine: string;
  /** このページに載せる項目 (最大12件) */
  items: string[];
  pageLabel: string;
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

  for (let k = 0; k < APPENDIX_ROWS_PER_PAGE; k++) {
    const itemRow = 6 + 2 * k;
    const text = input.items[k] ?? "";
    values[`item${k}`] = text;
    cells.push(
      { ref: `A${itemRow}`, field: `item${k}`, size: 11, v: "center", border: ITEM_ROW, shrink: true },
      {
        ref: `A${itemRow + 1}`,
        // 対応結果の見出しは項目がある行だけ (見本の別紙と同じ)
        text: text ? "対応結果：" : "",
        size: 11,
        v: "center",
        border: RESULT_ROW,
      },
      // チェック欄は項目行と対応結果行にまたがる (結合セル)
      { ref: `B${itemRow}:B${itemRow + 1}`, border: BOX },
    );
  }

  return {
    spec: {
      scale: APPENDIX_SHEET_METRICS.scale,
      originColumn: "A",
      x0: APPENDIX_SHEET_METRICS.x0,
      y0: APPENDIX_SHEET_METRICS.y0,
      colChars: APPENDIX_SHEET_METRICS.colChars,
      rowHeights: APPENDIX_SHEET_METRICS.rowHeights,
      cells,
    },
    values,
  };
}

/** 項目を1ページ12件ずつに分ける (13件以上のとき2ページ目を作る) */
export function paginateAppendixItems(items: string[]): string[][] {
  if (items.length === 0) return [[]];
  const pages: string[][] = [];
  for (let i = 0; i < items.length; i += APPENDIX_ROWS_PER_PAGE) {
    pages.push(items.slice(i, i + APPENDIX_ROWS_PER_PAGE));
  }
  return pages;
}
