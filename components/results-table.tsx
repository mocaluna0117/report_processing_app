"use client";

import type { ResultRow } from "@/lib/process";
import { COLUMNS } from "@/lib/tsv";
import type { Confidence } from "@/lib/types";

function cellClass(c: Confidence): string {
  if (c === "fail") return "border-red-300 bg-red-50";
  if (c === "warn") return "border-amber-300 bg-amber-50";
  return "border-slate-200 bg-white";
}

export function ResultsTable({
  results,
  onCellChange,
  onDownloadRow,
}: {
  results: ResultRow[];
  onCellChange: (pairId: string, col: number, value: string) => void;
  onDownloadRow: (row: ResultRow) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full min-w-[1300px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            {COLUMNS.map((c) => (
              <th
                key={c}
                className={`px-2 py-2 ${
                  c === "アフター受付内容"
                    ? "w-[24rem]"
                    : c === "PJ"
                      ? "w-32"
                      : c === "備考欄"
                        ? "w-44"
                        : c === "受付種別" || c === "引渡日" || c === "最終更新日"
                          ? "w-24"
                          : ""
                }`}
              >
                {c}
              </th>
            ))}
            <th className="w-28 px-2 py-2">結合PDF</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={row.pairId} className="border-b border-slate-100 align-top last:border-0">
              {row.error ? (
                <td colSpan={8} className="px-2 py-2">
                  <span className="text-red-600">
                    {row.ownerDisplay}: 処理に失敗しました — {row.error}
                  </span>
                </td>
              ) : (
                row.cells.map((value, col) => (
                  <td key={COLUMNS[col]} className="px-1 py-1.5">
                    {col === 7 ? (
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
              <td className="px-2 py-1.5">
                {row.merged ? (
                  <button
                    type="button"
                    onClick={() => onDownloadRow(row)}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    ダウンロード
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">なし</span>
                )}
              </td>
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
