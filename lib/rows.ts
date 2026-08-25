import { WORK_COL } from "@/lib/tsv";

/**
 * 1報告書分のセルを工事区分の数だけ行に展開する。
 * 工事区分が0件なら工事区分が空欄の1行を返す (他の列はすべて同じ値)。
 */
export function expandRow(cells: string[], categories: string[]): string[][] {
  if (categories.length === 0) return [cells];
  return categories.map((c) => cells.map((v, i) => (i === WORK_COL ? c : v)));
}
