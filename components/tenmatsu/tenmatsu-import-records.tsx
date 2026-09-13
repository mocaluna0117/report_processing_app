"use client";

import { useState } from "react";
import { Dropzone } from "@/components/dropzone";
import type { DocKind } from "@/lib/tenmatsu/kinds";
import type { LocalFolderClient } from "@/lib/tenmatsu/local/client";
import { type ImportSummary, importNameWarning } from "@/lib/tenmatsu/local/import";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";

const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 今までの方式（PCの顛末書取得ツール）の記録を、つないだフォルダーへ取り込む欄。
 * ファイルを入れる → 取り込むとどうなるかを見せる → 「取り込む」で書く、の2段にする（いきなり書かない）。
 */
export function TenmatsuImportRecords({
  kind,
  client,
  disabled,
  onImported,
}: {
  kind: DocKind;
  client: LocalFolderClient;
  /** 取得中など、取り込めないとき */
  disabled: boolean;
  /** 取り込んだあと（一覧を読み直す） */
  onImported: (summary: ImportSummary) => void;
}) {
  const cfg = LOCAL_KINDS[kind.id];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setText(null);
    setName("");
    setSummary(null);
    setError(null);
  };

  const choose = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    reset();
    setBusy(true);
    try {
      const body = await file.text();
      setSummary(await client.previewImport(body));
      setText(body);
      setName(file.name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (text === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.importRecords(text);
      reset();
      setOpen(false);
      onImported(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const warning = name ? importNameWarning(cfg, name) : null;

  return (
    <details
      className="mt-3 border-t border-slate-100 pt-3"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm font-medium text-slate-700">今までの方式 (PCのツール) の記録を取り込む</summary>
      <div className="mt-2 space-y-2 text-sm text-slate-600">
        <p>
          PCの顛末書取得ツールで取得した{kind.label}の記録を、このフォルダーへ移します。一覧・完了の印・{kind.text.resolveButton}の途中のものがそのまま使えます。
          ツールのフォルダー (tenmatsu-dl) にある <code className="rounded bg-slate-100 px-1">{cfg.processedFile}</code> を入れてください。
        </p>
        <p className="text-xs text-slate-500">
          PDFはツールの保存先フォルダー (例: ドキュメントの「{kind.label}」) にあるので、新しい方式でも同じフォルダーを選んでから取り込むと、一覧からPDFを開けます。
          何度取り込んでも同じ伝票が二重になることはありません。取り込む前の記録は _記録 に控え (.bak) として残ります。
          取り込んだあとは、ツールを止めて、新しい方式だけを使ってください (記録が別々になり、同じ伝票を二重に取得するため)。
        </p>
        {text === null ? (
          <Dropzone
            compact
            multiple={false}
            disabled={disabled || busy}
            accept=".json,application/json"
            pattern={/\.json$/i}
            onFiles={(files) => void choose(files)}
            title={busy ? "読み込んでいます…" : `${cfg.processedFile} をここにドロップ (クリックで選択)`}
            description="記録のファイルはこのブラウザの中で読みます。folio のサーバーには送りません。"
          />
        ) : (
          summary && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="font-medium text-slate-700">{name} を取り込むと</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                <li>
                  記録にある保存済みの{kind.label}: {summary.incoming}件 (一覧に新しく加わるのは {summary.added}件、すでにあるのは {summary.already}件)
                </li>
                <li>
                  PDF: このフォルダーに {summary.pdfFound}件見つかりました
                  {summary.pdfMissingCount > 0 && ` (見つからないもの ${summary.pdfMissingCount}件。例: ${summary.pdfMissing.slice(0, 3).join("、")})`}
                </li>
                {summary.flagsTaken > 0 && <li>完了の印: {summary.flagsTaken}件を取り込みます</li>}
                {summary.pendingTaken > 0 && <li>保留・アップロード待ち: {summary.pendingTaken}件を取り込みます</li>}
                {summary.pendingWithoutFiles.length > 0 && (
                  <li>
                    保留のファイルがこのフォルダーに無いので取り込まないもの: {summary.pendingWithoutFiles.length}件 (次の取得で取り直します)
                  </li>
                )}
                {summary.pendingAlreadySaved.length > 0 && <li>保存済みなので保留から外すもの: {summary.pendingAlreadySaved.length}件</li>}
              </ul>
              {summary.incoming > 0 && summary.pdfFound === 0 && (
                <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  PDFが1つも見つかりません。ツールの保存先とは別のフォルダーを選んでいる可能性があります。このまま取り込むと、一覧には「ファイルなし」と出ます。
                </p>
              )}
              {warning && (
                <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void run()} disabled={disabled || busy} className={PRIMARY_BUTTON_CLASS}>
                  {busy ? "取り込んでいます…" : "取り込む"}
                </button>
                <button type="button" onClick={reset} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
                  やめる
                </button>
              </div>
            </div>
          )
        )}
        {error && <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      </div>
    </details>
  );
}
