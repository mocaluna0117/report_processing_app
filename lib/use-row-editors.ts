"use client";

// 結果テーブルの行編集ハンドラ (定期点検・アフターメンテナンスで共通)。
// 行の持ち方 (スロット配列 / 追記配列) は画面ごとに違うので、更新関数だけ受け取る。
import type { ResultRow } from "@/lib/process";
import type { ReportOptions } from "@/lib/report/model";
import { distributeSummary, isSummarySplit, mergeSplitSummary } from "@/lib/summary";
import { SUMMARY_COL } from "@/lib/tsv";
import type { WorkCategoryEntry } from "@/lib/types";

export interface RowEditors {
  onCellChange: (pairId: string, col: number, value: string) => void;
  onKanaChange: (pairId: string, kana: string) => void;
  onReportOptionsChange: (pairId: string, options: ReportOptions) => void;
  onCategoryChange: (pairId: string, index: number, value: string) => void;
  onCategoryAdd: (pairId: string) => void;
  onCategoryRemove: (pairId: string, index: number) => void;
  /** 工事区分ごとに分けているときの、その区分の点検内容 */
  onCategorySummaryChange: (pairId: string, index: number, value: string) => void;
  /** 点検内容を工事区分ごとに分ける / 1つにまとめる */
  onSplitSummaryChange: (pairId: string, enabled: boolean) => void;
}

/** 各区分から分割中の本文を外す (まとめたあとに残さない) */
function withoutSummaries(cats: readonly WorkCategoryEntry[]): WorkCategoryEntry[] {
  return cats.map((c) => {
    const next = { ...c };
    delete next.summary;
    return next;
  });
}

export function useRowEditors<R extends ResultRow>(
  update: (pairId: string, fn: (row: R) => R) => void,
): RowEditors {
  const updateCategories = (
    pairId: string,
    fn: (cats: WorkCategoryEntry[]) => WorkCategoryEntry[],
  ) => update(pairId, (row) => ({ ...row, categories: fn(row.categories) }));

  /**
   * 分けていた本文を共通のセルへ戻す (工事区分が2件未満になったとき・手動でまとめたとき)。
   * 分けていない行では共通のセルに触らない (フラグだけ残った状態で本文を消さないため)。
   */
  const merge = (row: R, cats: WorkCategoryEntry[]): R => ({
    ...row,
    cells: isSummarySplit(row)
      ? row.cells.map((c, i) => (i === SUMMARY_COL ? mergeSplitSummary(cats) : c))
      : row.cells,
    categories: withoutSummaries(cats),
    splitSummary: false,
  });

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
        // 区分を選び直しても、その行に書いた点検内容は残す
        const summary = next[index]?.summary;
        next[index] = { value, confidence: "ok", ...(summary !== undefined ? { summary } : {}) };
        return next;
      }),
    onCategoryAdd: (pairId) =>
      update(pairId, (row) => {
        const cats = row.categories.length > 0 ? row.categories : [{ value: "", confidence: "ok" as const }];
        const added: WorkCategoryEntry = {
          value: "",
          confidence: "ok",
          // 分けている最中に足した行は、点検内容も空欄から書き始める
          ...(row.splitSummary ? { summary: "" } : {}),
        };
        return { ...row, categories: [...cats, added] };
      }),
    onCategoryRemove: (pairId, index) =>
      update(pairId, (row) => {
        const next = row.categories.filter((_, i) => i !== index);
        // 分ける相手がいなくなったら、残った本文を共通のセルに戻す
        if (row.splitSummary && next.length < 2) return merge(row, next);
        return { ...row, categories: next };
      }),
    onCategorySummaryChange: (pairId, index, value) =>
      updateCategories(pairId, (cats) =>
        cats.map((c, i) => (i === index ? { ...c, summary: value } : c)),
      ),
    onSplitSummaryChange: (pairId, enabled) =>
      update(pairId, (row) => {
        if (!enabled) return merge(row, row.categories);
        // 工事区分が1件だけなら分ける意味が無い
        if (row.categories.length < 2) return row;
        const texts = distributeSummary(
          row.cells[SUMMARY_COL] ?? "",
          row.categories.map((c) => c.value),
        );
        return {
          ...row,
          splitSummary: true,
          categories: row.categories.map((c, i) => ({ ...c, summary: texts[i] ?? "" })),
        };
      }),
  };
}
