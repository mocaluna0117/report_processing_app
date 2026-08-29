"use client";

// 結果テーブルの行編集ハンドラ (定期点検・アフターメンテナンスで共通)。
// 行の持ち方 (スロット配列 / 追記配列) は画面ごとに違うので、更新関数だけ受け取る。
import type { ResultRow } from "@/lib/process";
import type { ReportOptions } from "@/lib/report/model";
import type { WorkCategoryEntry } from "@/lib/types";

export interface RowEditors {
  onCellChange: (pairId: string, col: number, value: string) => void;
  onKanaChange: (pairId: string, kana: string) => void;
  onReportOptionsChange: (pairId: string, options: ReportOptions) => void;
  onCategoryChange: (pairId: string, index: number, value: string) => void;
  onCategoryAdd: (pairId: string) => void;
  onCategoryRemove: (pairId: string, index: number) => void;
}

export function useRowEditors<R extends ResultRow>(
  update: (pairId: string, fn: (row: R) => R) => void,
): RowEditors {
  const updateCategories = (
    pairId: string,
    fn: (cats: WorkCategoryEntry[]) => WorkCategoryEntry[],
  ) => update(pairId, (row) => ({ ...row, categories: fn(row.categories) }));

  return {
    onCellChange: (pairId, col, value) =>
      update(pairId, (row) => ({
        ...row,
        cells: row.cells.map((c, i) => (i === col ? value : c)),
      })),
    // メール文用のカナ読みの手修正 (確認画面で編集した値を保持する)
    onKanaChange: (pairId, kana) =>
      update(pairId, (row) => ({ ...row, mail: { ...row.mail, ownerKana: kana } })),
    onReportOptionsChange: (pairId, options) => update(pairId, (row) => ({ ...row, report: options })),
    onCategoryChange: (pairId, index, value) =>
      updateCategories(pairId, (cats) => {
        const next: WorkCategoryEntry[] =
          cats.length > 0 ? [...cats] : [{ value: "", confidence: "ok" }];
        next[index] = { value, confidence: "ok" };
        return next;
      }),
    onCategoryAdd: (pairId) =>
      updateCategories(pairId, (cats) => [
        ...(cats.length > 0 ? cats : [{ value: "", confidence: "ok" as const }]),
        { value: "", confidence: "ok" },
      ]),
    onCategoryRemove: (pairId, index) =>
      updateCategories(pairId, (cats) => cats.filter((_, i) => i !== index)),
  };
}
