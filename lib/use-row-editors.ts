"use client";

// 結果テーブルの行編集ハンドラ (定期点検・アフターメンテナンスで共通)。
// 行の持ち方 (スロット配列 / 追記配列) は画面ごとに違うので、更新関数だけ受け取る。
import type { ResultRow } from "@/lib/process";
import type { ReportOptions } from "@/lib/report/model";
import {
  attachSummaries,
  isSummarySplit,
  mergeSplitSummary,
  syncSummaryCell,
  withoutSummaries,
} from "@/lib/summary";
import { SUMMARY_COL } from "@/lib/tsv";
import type { Contact, WorkCategoryEntry } from "@/lib/types";

export interface RowEditors {
  onCellChange: (pairId: string, col: number, value: string) => void;
  onKanaChange: (pairId: string, kana: string) => void;
  /** 連絡先①②の差し替え (完了報告書ダイアログの見出し欄)。カナなど mail の他の値は保つ */
  onContactsChange: (pairId: string, contacts: Contact[]) => void;
  onReportOptionsChange: (pairId: string, options: ReportOptions) => void;
  onCategoryChange: (pairId: string, index: number, value: string) => void;
  onCategoryAdd: (pairId: string) => void;
  onCategoryRemove: (pairId: string, index: number) => void;
  /** 工事区分が2件以上のときの、その区分の行の点検内容 */
  onCategorySummaryChange: (pairId: string, index: number, value: string) => void;
}

export function useRowEditors<R extends ResultRow>(
  update: (pairId: string, fn: (row: R) => R) => void,
): RowEditors {
  /** 工事区分を差し替え、2件以上なら共通のセルを各行の本文の鏡に保つ */
  const setCategories = (row: R, categories: WorkCategoryEntry[]): R => ({
    ...row,
    categories,
    cells: syncSummaryCell(row.cells, categories),
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
    onContactsChange: (pairId, contacts) =>
      update(pairId, (row) => ({ ...row, mail: { ...row.mail, contacts } })),
    onReportOptionsChange: (pairId, options) =>
      update(pairId, (row) => ({ ...row, report: options })),
    onCategoryChange: (pairId, index, value) =>
      update(pairId, (row) => {
        const next: WorkCategoryEntry[] =
          row.categories.length > 0 ? [...row.categories] : [{ value: "", confidence: "ok" }];
        // 区分を選び直しても、その行に書いた点検内容は残す (本文が変わらないので鏡もそのまま)
        const summary = next[index]?.summary;
        next[index] = { value, confidence: "ok", ...(summary !== undefined ? { summary } : {}) };
        return { ...row, categories: next };
      }),
    onCategoryAdd: (pairId) =>
      update(pairId, (row) => {
        const cats =
          row.categories.length > 0 ? row.categories : [{ value: "", confidence: "ok" as const }];
        const added: WorkCategoryEntry = { value: "", confidence: "ok" };
        // 1件→2件になった瞬間に、共通のセルの本文を区分ごとに振り分ける
        // (足した行は区分が空欄なので、事象はいったん元の行に残る)
        if (cats.length < 2) return { ...row, ...attachSummaries(row.cells, [...cats, added]) };
        // 既に分けていれば、足した行は点検内容も空欄から書き始める
        return setCategories(row, [...cats, { ...added, summary: "" }]);
      }),
    onCategoryRemove: (pairId, index) =>
      update(pairId, (row) => {
        const next = row.categories.filter((_, i) => i !== index);
        if (isSummarySplit(row) && next.length < 2) {
          // 分ける相手がいなくなったら、残った行の本文を共通のセルに戻す (消した行の本文は落とす)
          return {
            ...row,
            cells: row.cells.map((c, i) => (i === SUMMARY_COL ? mergeSplitSummary(next) : c)),
            categories: withoutSummaries(next),
          };
        }
        return setCategories(row, next);
      }),
    onCategorySummaryChange: (pairId, index, value) =>
      update(pairId, (row) =>
        setCategories(
          row,
          row.categories.map((c, i) => (i === index ? { ...c, summary: value } : c)),
        ),
      ),
  };
}
