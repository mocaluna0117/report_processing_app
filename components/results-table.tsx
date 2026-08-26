"use client";

import type { ResultRow } from "@/lib/process";
import { COLUMNS, SUMMARY_COL, WORK_COL } from "@/lib/tsv";
import type { Confidence, WorkCategoryEntry } from "@/lib/types";
import { WORK_CATEGORIES } from "@/lib/work-categories";

function cellClass(c: Confidence): string {
  if (c === "fail") return "border-red-300 bg-red-50";
  if (c === "warn") return "border-amber-300 bg-amber-50";
  return "border-slate-200 bg-white";
}

/** 列ごとの幅 (未指定の空白列などは w-20) */
const COL_WIDTH: Record<string, string> = {
  物件数: "w-16",
  PJ: "w-32",
  受付種別: "w-20",
  受付日: "w-28",
  受付者: "w-20",
  担当: "w-16",
  事業者: "w-36",
  物件名称: "w-56",
  お客様氏名: "w-28",
  住所: "w-52",
  引渡日: "w-28",
  完了報告書取得日: "w-28",
  工事区分: "w-48",
  アフター受付内容: "w-[24rem]",
  最終更新日: "w-24",
  備考欄: "w-44",
};

const EMPTY_CATEGORY: WorkCategoryEntry = { value: "", confidence: "ok" };

export function ResultsTable({
  results,
  onCellChange,
  onDownloadRow,
  onCopyRow,
  copiedRowId,
  onCategoryChange,
  onCategoryAdd,
  onCategoryRemove,
}: {
  results: ResultRow[];
  onCellChange: (pairId: string, col: number, value: string) => void;
  onDownloadRow: (row: ResultRow) => void;
  onCopyRow: (row: ResultRow) => void;
  copiedRowId: string | null;
  onCategoryChange: (pairId: string, index: number, value: string) => void;
  onCategoryAdd: (pairId: string) => void;
  onCategoryRemove: (pairId: string, index: number) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full min-w-[2600px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            {/* 施主列は左端に固定し、横スクロールの対象外にする (コピー対象外のUI見出し) */}
            <th className="sticky left-0 z-10 w-28 whitespace-nowrap border-r border-slate-200 bg-slate-50 px-2 py-2">
              施主
            </th>
            {COLUMNS.map((c) => (
              <th
                key={c}
                className={`whitespace-nowrap px-2 py-2 ${COL_WIDTH[c] ?? "w-20"}`}
              >
                {c}
              </th>
            ))}
            {/* 操作列は右端に固定し、横スクロールの対象外にする */}
            <th className="sticky right-0 z-10 w-32 whitespace-nowrap border-l border-slate-200 bg-slate-50 px-2 py-2">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => {
            // 同じ報告書の行は工事区分の数だけ展開し、共通列は rowSpan でまとめて表示する
            const cats = row.categories.length > 0 ? row.categories : [EMPTY_CATEGORY];
            const span = cats.length;
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
                      <td colSpan={COLUMNS.length} rowSpan={span} className="px-2 py-2">
                        <span className="text-red-600">
                          {row.ownerDisplay}: 処理に失敗しました — {row.error}
                        </span>
                      </td>
                    )
                  : row.cells.map((value, col) => {
                      if (col === WORK_COL) {
                        return (
                          <td key={COLUMNS[col]} className="px-1 py-1.5">
                            <div className="flex items-center gap-1">
                              <select
                                value={cat.value}
                                title={cat.item ? `シート上の項目: ${cat.item}` : undefined}
                                onChange={(e) => onCategoryChange(row.pairId, k, e.target.value)}
                                className={`w-full rounded border px-1 py-1 text-sm ${cellClass(cat.confidence)}`}
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
                                  onClick={() => onCategoryRemove(row.pairId, k)}
                                  className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                                >
                                  ✕
                                </button>
                              )}
                              {k === span - 1 && (
                                <button
                                  type="button"
                                  title="工事区分の行を追加"
                                  onClick={() => onCategoryAdd(row.pairId)}
                                  className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                                >
                                  ＋
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      }
                      if (k !== 0) return null;
                      return (
                        <td key={COLUMNS[col]} rowSpan={span} className="px-1 py-1.5">
                          {col === SUMMARY_COL ? (
                            <div>
                              <textarea
                                value={value}
                                rows={4}
                                onChange={(e) => onCellChange(row.pairId, col, e.target.value)}
                                className={`w-full rounded border px-2 py-1 text-sm leading-snug ${cellClass(row.confidences[col])}`}
                              />
                              {row.engine && (
                                <span
                                  className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                    row.engine === "gemini"
                                      ? "bg-blue-100 text-blue-800"
                                      : "bg-slate-200 text-slate-600"
                                  }`}
                                >
                                  {row.engine === "gemini" ? "Gemini要約" : "定型要約"}
                                </span>
                              )}
                            </div>
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
                      {row.merged ? (
                        <button
                          type="button"
                          onClick={() => onDownloadRow(row)}
                          className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          PDFをDL
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">PDFなし</span>
                      )}
                      {!row.error && (
                        <span
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
                    </div>
                  </td>
                )}
              </tr>
            ));
          })}
        </tbody>
      </table>
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
