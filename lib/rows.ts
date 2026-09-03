import { isSummarySplit, type SummarySplitSource } from "@/lib/summary";
import { SUMMARY_COL, WORK_COL } from "@/lib/tsv";

/** 行に展開するときの工事区分1件分 (summary があればその行の点検内容を差し替える) */
export interface RowCategory {
  value: string;
  /** 工事区分ごとに点検内容を分けているときの本文。undefined なら共通のセルを使う */
  summary?: string;
}

/**
 * 1報告書分のセルを工事区分の数だけ行に展開する。
 * 工事区分が0件なら工事区分が空欄の1行を返す (他の列はすべて同じ値)。
 * summary を持つ区分は、その行の点検内容だけを差し替える。
 */
export function expandRow(cells: string[], categories: readonly RowCategory[]): string[][] {
  if (categories.length === 0) return [cells];
  return categories.map((c) =>
    cells.map((v, i) => {
      if (i === WORK_COL) return c.value;
      if (i === SUMMARY_COL && c.summary !== undefined) return c.summary;
      return v;
    }),
  );
}

/** ResultRow を貼り付け用の行に展開する (分けていれば区分ごとの点検内容を使う) */
export function expandResultRow(
  row: SummarySplitSource & { categories: readonly RowCategory[] },
): string[][] {
  const split = isSummarySplit(row);
  return expandRow(
    row.cells,
    row.categories.map((c) => (split ? { value: c.value, summary: c.summary ?? "" } : { value: c.value })),
  );
}

/**
 * 指定した列を落とす (アフターメンテナンスは備考欄を貼り付けない)。
 * ヘッダー行にも同じものを掛けること。
 */
export function dropColumns(rows: string[][], hidden: ReadonlySet<number>): string[][] {
  if (hidden.size === 0) return rows;
  return rows.map((r) => r.filter((_, i) => !hidden.has(i)));
}
