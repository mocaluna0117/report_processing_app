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
import { attachTreatments, mergeTreatments, withoutTreatments } from "@/lib/treatment";
import { SUMMARY_COL, TREATMENT_COL } from "@/lib/tsv";
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
  /** 工事区分が2件以上のときの、その区分の行の処置 */
  onCategoryTreatmentChange: (pairId: string, index: number, value: string) => void;
}

export function useRowEditors<R extends ResultRow>(
  update: (pairId: string, fn: (row: R) => R) => void,
): RowEditors {
  /** 工事区分を差し替え、2件以上なら共通のセルを各行の本文・処置の鏡に保つ */
  const setCategories = (row: R, categories: WorkCategoryEntry[]): R => ({
    ...row,
    ...attachTreatments(syncSummaryCell(row.cells, categories), categories),
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
        // 区分を選び直しても、その行に書いた点検内容・処置は残す (中身が変わらないので鏡もそのまま)
        const { summary, treatment } = next[index] ?? {};
        next[index] = {
          value,
          confidence: "ok",
          ...(summary !== undefined ? { summary } : {}),
          ...(treatment !== undefined ? { treatment } : {}),
        };
        return { ...row, categories: next };
      }),
    onCategoryAdd: (pairId) =>
      update(pairId, (row) => {
        const cats =
          row.categories.length > 0 ? row.categories : [{ value: "", confidence: "ok" as const }];
        const added: WorkCategoryEntry = { value: "", confidence: "ok" };
        // 1件→2件になった瞬間に、共通のセルの本文を区分ごとに振り分ける
        // (足した行は区分が空欄なので、事象はいったん元の行に残る)。処置は元の行 (先頭) に残す
        if (cats.length < 2) {
          const attached = attachSummaries(row.cells, [...cats, added]);
          return { ...row, ...attachTreatments(attached.cells, attached.categories) };
        }
        // 既に分けていれば、足した行は点検内容・処置も空欄から書き始める
        return setCategories(row, [...cats, { ...added, summary: "", treatment: "" }]);
      }),
    onCategoryRemove: (pairId, index) =>
      update(pairId, (row) => {
        const next = row.categories.filter((_, i) => i !== index);
        if (isSummarySplit(row) && next.length < 2) {
          // 分ける相手がいなくなったら、残った行の本文・処置を共通のセルに戻す (消した行の分は落とす)
          const merged: Record<number, string> = {
            [SUMMARY_COL]: mergeSplitSummary(next),
            [TREATMENT_COL]: mergeTreatments(next),
          };
          return {
            ...row,
            cells: row.cells.map((c, i) => merged[i] ?? c),
            categories: withoutTreatments(withoutSummaries(next)),
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
    onCategoryTreatmentChange: (pairId, index, value) =>
      update(pairId, (row) =>
        setCategories(
          row,
          row.categories.map((c, i) => (i === index ? { ...c, treatment: value } : c)),
        ),
      ),
  };
}
