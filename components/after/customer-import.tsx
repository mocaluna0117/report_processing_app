"use client";

import { Dropzone } from "@/components/dropzone";
import type { ImportReport } from "@/lib/after/customer-store";
import type { CustomerSource } from "@/lib/after/types";

const SOURCE_LABEL: Record<CustomerSource, string> = {
  suketto: "助っ人クラウド",
  dx: "点検保守台帳 (DX)",
};

export interface CustomerSummary {
  total: number;
  bySource: Record<CustomerSource, number>;
  lastImportedAt: number | null;
  needsReview: number;
}

function formatDate(ms: number | null): string {
  if (ms === null) return "－";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** 顧客データの取り込み (xlsx/csv) と件数の表示 */
export function CustomerImport({
  summary,
  report,
  importing,
  error,
  onImport,
  onDelete,
  onShowReview,
}: {
  summary: CustomerSummary;
  report: ImportReport | null;
  importing: boolean;
  error: string | null;
  onImport: (file: File) => void;
  onDelete: () => void;
  onShowReview: () => void;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">顧客データ</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {summary.total > 0 ? (
              <>
                {summary.total.toLocaleString()}件
                <span className="ml-2 text-xs text-slate-500">
                  ({SOURCE_LABEL.suketto} {summary.bySource.suketto.toLocaleString()}件 /{" "}
                  {SOURCE_LABEL.dx} {summary.bySource.dx.toLocaleString()}件・最終取り込み{" "}
                  {formatDate(summary.lastImportedAt)})
                </span>
              </>
            ) : (
              "まだ取り込んでいません。顧客情報のxlsx / csv を取り込んでください"
            )}
          </p>
          {summary.needsReview > 0 && (
            <button
              type="button"
              onClick={onShowReview}
              className="mt-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-200"
            >
              要確認 {summary.needsReview}件 (事業者やPJが未設定) を表示
            </button>
          )}
        </div>
        {summary.total > 0 && (
          <button
            type="button"
            onClick={onDelete}
            disabled={importing}
            className="whitespace-nowrap rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            顧客データを削除
          </button>
        )}
      </div>

      <div className="mt-3">
        <Dropzone
          onFiles={(files) => onImport(files[0])}
          disabled={importing}
          compact
          multiple={false}
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          pattern={/\.(xlsx|csv)$/i}
          title={importing ? "取り込み中…" : "顧客情報のファイル (xlsx / csv) をドロップ"}
          description={
            <>
              助っ人クラウド・点検保守台帳のどちらの形式かは自動で判定します。
              <br />
              取り込んだ顧客データはこのブラウザ内にだけ保存されます。
            </>
          }
        />
      </div>

      {error && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {report && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <p className="font-medium text-slate-700">
            {SOURCE_LABEL[report.source]} を取り込みました ({report.fileName})
          </p>
          <p className="mt-1">
            追加 {report.added}件 / 更新 {report.updated}件
            {report.removed > 0 && ` / 削除 ${report.removed}件`}
            {report.editsPreserved > 0 && ` / 手直しを引き継ぎ ${report.editsPreserved}件`}
            {report.needsReview > 0 && ` / 要確認 ${report.needsReview}件`}
          </p>
          {report.skipped.length > 0 && (
            <ul className="mt-1 list-inside list-disc">
              {report.skipped.map((s) => (
                <li key={s.reason}>
                  {s.reason}: {s.count}件
                  <span className="ml-1 text-slate-400">
                    (行 {s.rows.join(", ")}
                    {s.count > s.rows.length ? " ほか" : ""})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
