"use client";

import type { ReactNode } from "react";
import type { ColumnName } from "@/lib/cells";
import type { ResultRow } from "@/lib/process";
import { isSummarySplit } from "@/lib/summary";
import { COLUMNS, SUMMARY_COL, TREATMENT_COL, WORK_COL } from "@/lib/tsv";
import type { Confidence, WorkCategoryEntry } from "@/lib/types";
import { WORK_CATEGORIES } from "@/lib/work-categories";

function cellClass(c: Confidence): string {
  if (c === "fail") return "border-red-300 bg-red-50";
  if (c === "warn") return "border-amber-300 bg-amber-50";
  return "border-slate-200 bg-white";
}

/**
 * 列ごとの幅。表は table-fixed なので、この見出しの幅がそのまま列幅になる
 * (中身が長くても列は広がらず、入力欄が縮められることもない)。
 * 下限は見出し (text-xs = 1文字12px + 左右の余白16px) が収まる幅。
 * 合計: 24列 3248px / アフター (備考欄なし) 3072px。変えたら table の min-w も合わせる。
 */
const COL_WIDTH: Record<ColumnName, string> = {
  物件数: "w-16",
  PJ: "w-32",
  // 「－ 未選択 －」+ 矢印が w-28 では切れる
  受付種別: "w-32",
  受付日: "w-28",
  受付者: "w-20",
  担当: "w-16",
  事業者: "w-36",
  物件名称: "w-56",
  お客様氏名: "w-28",
  住所: "w-52",
  引渡日: "w-28",
  監督: "w-16",
  営業: "w-16",
  初回訪問日: "w-20",
  前回対応日: "w-20",
  対応予定日: "w-20",
  完了日: "w-16",
  完了報告書取得日: "w-32",
  工事区分: "w-48",
  アフター受付内容: "w-[24rem]",
  処置: "w-[24rem]",
  手配業者: "w-20",
  最終更新日: "w-24",
  備考欄: "w-44",
};

/**
 * アフター受付内容・処置の入力欄。
 * 表は table-fixed で見出しの幅 (w-[24rem]) がそのまま列幅になるので、w-full で2列の実寸が揃う。
 * 固定幅 (w-96 = 列幅と同じ) のままだと、セルの余白 (px-1) の分だけ列からはみ出す。
 */
const BIG_CELL_CLASS = "w-full rounded border px-2 py-1 text-sm leading-snug";

const EMPTY_CATEGORY: WorkCategoryEntry = { value: "", confidence: "ok" };

/** 決まった値から選ばせる列 (アフターメンテナンスの受付種別・受付者) */
export interface SelectColumn {
  options: readonly string[];
  /** 未選択の表示 */
  emptyLabel?: string;
  /** 未選択のときに要確認 (黄色) にする */
  warnEmpty?: boolean;
}

export function ResultsTable<R extends ResultRow>({
  results,
  onCellChange,
  onDownloadRow,
  onCopyRow,
  copiedRowId,
  onCategoryChange,
  onCategoryAdd,
  onCategoryRemove,
  onCategorySummaryChange,
  onOpenMail,
  onOpenReport,
  onPrefetchReport,
  onDeleteRow,
  deleteTitle,
  renderRowActions,
  hiddenColumns,
  selectColumns,
  columnLabels,
  showPdf = true,
  rowLabel = "施主",
}: {
  results: R[];
  onCellChange: (pairId: string, col: number, value: string) => void;
  /** showPdf を false にした画面では使わない */
  onDownloadRow?: (row: R) => void;
  onCopyRow: (row: R) => void;
  copiedRowId: string | null;
  onCategoryChange: (pairId: string, index: number, value: string) => void;
  onCategoryAdd: (pairId: string) => void;
  onCategoryRemove: (pairId: string, index: number) => void;
  /** 工事区分が2件以上のときの、その区分の行の点検内容 */
  onCategorySummaryChange: (pairId: string, index: number, value: string) => void;
  onOpenMail: (row: R) => void;
  onOpenReport: (row: R) => void;
  /** 完了報告書のテンプレート・フォントを先読みする (ボタンにカーソルを乗せた時) */
  onPrefetchReport: () => void;
  /** 行の削除 (アフターメンテナンスの受付取り消し・定期点検の1件削除)。渡さなければボタンを出さない */
  onDeleteRow?: (row: R) => void;
  /** 削除ボタンの説明 (何が消えるかが画面によって違う) */
  deleteTitle?: string;
  /** 画面ごとの追加ボタン (アフターメンテナンスの「この書き方を学習」) */
  renderRowActions?: (row: R) => ReactNode;
  /** 表示しない列 (アフターメンテナンスの備考欄) */
  hiddenColumns?: ReadonlySet<number>;
  /** プルダウンにする列 */
  selectColumns?: Record<number, SelectColumn>;
  /** 画面ごとの列名の読み替え (定期点検の「点検内容」など) */
  columnLabels?: Readonly<Record<number, string>>;
  /** 結合PDFのダウンロード欄を出すか */
  showPdf?: boolean;
  /** 左端の固定列の見出し */
  rowLabel?: string;
}) {
  const isHidden = (col: number) => hiddenColumns?.has(col) ?? false;
  const visibleColumnCount = COLUMNS.length - (hiddenColumns?.size ?? 0);
  return (
    // 枠線・角丸は外側に持たせ、スクロールするのは表だけにする
    // (警告の一覧を枠の外に置いて、行が増えても必ず表の下に見えるようにする)。
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      {/* 行が増えても横スクロールバーに届くよう、表の高さを区切ってこの中でスクロールさせる。
          縦もこの中でスクロールするので、見出しの sticky が画面内に残る。
          scroll-p* は Tab移動でセルが固定した見出し・左右の列の下に潜らないための余白。 */}
      <div className="max-h-[70vh] scroll-pt-10 scroll-pl-28 scroll-pr-44 overflow-auto">
        {/* min-w は列幅の合計 (アフターの23列分)。fixed の表幅は max(width, 列幅の合計) なので
            定期点検 (24列) は合計まで伸びる。合計より大きくすると余りが全列 (固定列を含む) に
            配られて幅指定と scroll-pr がずれるので、増やすときは COL_WIDTH と一緒に見直す。 */}
        <table className="w-full min-w-[3360px] table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              {/* 施主列は左端に固定し、横スクロールの対象外にする (コピー対象外のUI見出し) */}
              <th className="sticky left-0 top-0 z-30 w-28 whitespace-nowrap border-r border-b border-slate-200 bg-slate-50 px-2 py-2">
                {rowLabel}
              </th>
              {COLUMNS.map((c, i) =>
                isHidden(i) ? null : (
                  <th
                    key={c}
                    className={`sticky top-0 z-20 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-2 py-2 ${COL_WIDTH[c]}`}
                  >
                    {columnLabels?.[i] ?? c}
                  </th>
                ),
              )}
              {/* 操作列は右端に固定し、横スクロールの対象外にする */}
              <th className="sticky right-0 top-0 z-30 w-44 whitespace-nowrap border-l border-b border-slate-200 bg-slate-50 px-2 py-2">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((row) => {
              // 同じ報告書の行は工事区分の数だけ展開し、共通列は rowSpan でまとめて表示する
              const cats = row.categories.length > 0 ? row.categories : [EMPTY_CATEGORY];
              const span = cats.length;
              // 工事区分が2件以上あれば、点検内容は常に区分ごとの入力欄になる
              const split = isSummarySplit(row);
              const summaryLabel = columnLabels?.[SUMMARY_COL] ?? COLUMNS[SUMMARY_COL];
              // 点検内容の下の注記 (要約エンジンのバッジ)
              const summaryFooter = row.engine && (
                <div className="mt-0.5">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      row.engine === "gemini"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {row.engine === "gemini" ? "Gemini要約" : "定型要約"}
                  </span>
                </div>
              );
              return cats.map((cat, k) => (
                <tr
                  key={`${row.pairId}-${k}`}
                  className={`align-top ${k === 0 ? "border-t-2 border-slate-300" : ""}`}
                >
                  {k === 0 && (
                    <td
                      rowSpan={span}
                      className="sticky left-0 z-10 border-r border-slate-200 bg-white px-2 py-2"
                    >
                      <p className="max-w-28 truncate text-sm font-medium" title={row.ownerDisplay}>
                        {row.ownerDisplay || "－"}
                      </p>
                      {span > 1 && (
                        <p className="text-[10px] text-slate-400">{span}行に展開</p>
                      )}
                    </td>
                  )}

                  {row.error
                    ? k === 0 && (
                        <td colSpan={visibleColumnCount} rowSpan={span} className="px-2 py-2">
                          <span className="text-red-600">
                            {row.ownerDisplay}: 処理に失敗しました — {row.error}
                          </span>
                        </td>
                      )
                    : row.cells.map((value, col) => {
                        if (isHidden(col)) return null;
                        if (col === WORK_COL) {
                          return (
                            <td key={COLUMNS[col]} className="px-1 py-1.5">
                              <div className="flex items-center gap-1">
                                <select
                                  value={cat.value}
                                  title={cat.item ? `シート上の項目: ${cat.item}` : undefined}
                                  onChange={(e) => onCategoryChange(row.pairId, k, e.target.value)}
                                  className={`w-full min-w-32 rounded border px-1 py-1 text-sm ${cellClass(cat.confidence)}`}
                                >
                                  <option value="">－</option>
                                  {WORK_CATEGORIES.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                                {row.categories.length > 0 && (
                                  <button
                                    type="button"
                                    title="この工事区分の行を削除"
                                    onClick={() => {
                                      if (
                                        split &&
                                        (cat.summary ?? "").trim() &&
                                        !confirm(`この行に書いた${summaryLabel}も削除します。よろしいですか？`)
                                      ) {
                                        return;
                                      }
                                      onCategoryRemove(row.pairId, k);
                                    }}
                                    className="shrink-0 rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                                  >
                                    ✕
                                  </button>
                                )}
                                {k === span - 1 && (
                                  <button
                                    type="button"
                                    title="工事区分の行を追加"
                                    onClick={() => onCategoryAdd(row.pairId)}
                                    className="shrink-0 rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                                  >
                                    ＋
                                  </button>
                                )}
                            </div>
                          </td>
                        );
                      }
                      // 工事区分が2件以上のときは、点検内容も行ごとの入力欄にする
                      if (col === SUMMARY_COL && split) {
                        return (
                          <td key={COLUMNS[col]} className="px-1 py-1.5">
                            <textarea
                              value={cat.summary ?? ""}
                              rows={4}
                              placeholder={
                                cat.value ? `${cat.value}の${summaryLabel}` : summaryLabel
                              }
                              onChange={(e) =>
                                onCategorySummaryChange(row.pairId, k, e.target.value)
                              }
                              className={`${BIG_CELL_CLASS} ${cellClass(row.confidences[col])}`}
                            />
                            {k === 0 && summaryFooter}
                          </td>
                        );
                      }
                      if (k !== 0) return null;
                      return (
                        <td key={COLUMNS[col]} rowSpan={span} className="px-1 py-1.5">
                          {col === SUMMARY_COL || col === TREATMENT_COL ? (
                            <div>
                              <textarea
                                value={value}
                                rows={6}
                                onChange={(e) => onCellChange(row.pairId, col, e.target.value)}
                                className={`${BIG_CELL_CLASS} ${cellClass(row.confidences[col])}`}
                              />
                              {col === SUMMARY_COL && summaryFooter}
                            </div>
                          ) : selectColumns?.[col] ? (
                            <select
                              value={value}
                              onChange={(e) => onCellChange(row.pairId, col, e.target.value)}
                              className={`w-full rounded border px-1 py-1 text-sm ${cellClass(
                                selectColumns[col].warnEmpty && !value ? "warn" : row.confidences[col],
                              )}`}
                            >
                              <option value="">{selectColumns[col].emptyLabel ?? "－"}</option>
                              {selectColumns[col].options.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                              {/* 保存済みの値が選択肢に無い場合も消さずに残す */}
                              {value && !selectColumns[col].options.includes(value) && (
                                <option value={value}>{value}</option>
                              )}
                            </select>
                          ) : (
                            <input
                              value={value}
                              onChange={(e) => onCellChange(row.pairId, col, e.target.value)}
                              className={`w-full rounded border px-2 py-1 text-sm ${cellClass(row.confidences[col])}`}
                            />
                          )}
                        </td>
                      );
                    })}

                {k === 0 && (
                  <td
                    rowSpan={span}
                    className="sticky right-0 z-10 border-l border-slate-200 bg-white px-2 py-1.5"
                  >
                    <div className="flex flex-col items-start gap-1">
                      {!row.error && (
                        <button
                          type="button"
                          onClick={() => onCopyRow(row)}
                          className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium ${
                            copiedRowId === row.pairId
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                              : "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700"
                          }`}
                        >
                          {copiedRowId === row.pairId ? "コピー済 ✓" : "行をコピー"}
                        </button>
                      )}
                      {showPdf &&
                        (row.merged ? (
                        <button
                          type="button"
                          onClick={() => onDownloadRow?.(row)}
                          className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          PDFをDL
                        </button>
                        ) : (
                          <span className="text-xs text-slate-400">PDFなし</span>
                        ))}
                      {!row.error && (
                        <button
                          type="button"
                          onClick={() => onOpenMail(row)}
                          className="whitespace-nowrap rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100"
                        >
                          メール文
                        </button>
                      )}
                      {!row.error && (
                        <button
                          type="button"
                          onClick={() => onOpenReport(row)}
                          onMouseEnter={onPrefetchReport}
                          className="whitespace-nowrap rounded-md border border-slate-400 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50"
                        >
                          完了報告書
                        </button>
                      )}
                      {!row.error && renderRowActions?.(row)}
                      {!row.error && (
                        <span
                          title={row.categoryModel ? `判定モデル: ${row.categoryModel}` : undefined}
                          className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            row.categoryEngine === "gemini"
                              ? "bg-blue-100 text-blue-800"
                              : "bg-slate-200 text-slate-600"
                          }`}
                        >
                          工事区分 {row.categories.length}件
                          {row.categoryEngine === "gemini" ? " (Gemini判定)" : " (手動)"}
                        </span>
                      )}
                      {onDeleteRow && (
                        <button
                          type="button"
                          title={deleteTitle}
                          onClick={() => onDeleteRow(row)}
                          className="cursor-pointer whitespace-nowrap rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                        >
                          削除
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ));
          })}
        </tbody>
        </table>
      </div>
      {results.some((r) => r.warnings.length > 0) && (
        <div className="border-t border-slate-200 bg-amber-50/50 px-3 py-2 text-xs text-amber-900">
          {results
            .filter((r) => r.warnings.length > 0)
            .map((r) => (
              <p key={r.pairId}>
                <span className="font-medium">{r.ownerDisplay}:</span>{" "}
                {r.warnings.join(" / ")}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
