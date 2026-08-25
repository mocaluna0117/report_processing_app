"use client";

import type { ResultRow } from "@/lib/process";
import { COLUMNS, SUMMARY_COL } from "@/lib/tsv";
import type { Confidence } from "@/lib/types";

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
  アフター受付内容: "w-[24rem]",
  最終更新日: "w-24",
  備考欄: "w-44",
};

export function ResultsTable({
  results,
  onCellChange,
  onDownloadRow,
  onCopyRow,
  copiedRowId,
}: {
  results: ResultRow[];
  onCellChange: (pairId: string, col: number, value: string) => void;
  onDownloadRow: (row: ResultRow) => void;
  onCopyRow: (row: ResultRow) => void;
  copiedRowId: string | null;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full min-w-[2500px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            <th className="sticky left-0 z-10 w-28 bg-slate-50 px-2 py-2">操作</th>
            {COLUMNS.map((c) => (
              <th key={c} className={`px-2 py-2 ${COL_WIDTH[c] ?? "w-20"}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={row.pairId} className="border-b border-slate-100 align-top last:border-0">
              <td className="sticky left-0 z-10 bg-white px-2 py-1.5">
                <div className="flex flex-col items-start gap-1">
                  {!row.error && (
                    <button
                      type="button"
                      onClick={() => onCopyRow(row)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
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
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      PDFをDL
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">PDFなし</span>
                  )}
                  <p className="max-w-28 truncate text-[10px] text-slate-400">
                    {row.ownerDisplay}
                  </p>
                </div>
              </td>
              {row.error ? (
                <td colSpan={COLUMNS.length} className="px-2 py-2">
                  <span className="text-red-600">
                    {row.ownerDisplay}: 処理に失敗しました — {row.error}
                  </span>
                </td>
              ) : (
                row.cells.map((value, col) => (
                  <td key={COLUMNS[col]} className="px-1 py-1.5">
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
                ))
              )}
            </tr>
          ))}
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
