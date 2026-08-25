"use client";

import { useMemo, useRef, useState } from "react";
import { Dropzone } from "@/components/dropzone";
import { PairTable, type PairView } from "@/components/pair-table";
import { ResultsTable } from "@/components/results-table";
import { pairFiles, parseFileName } from "@/lib/pairing";
import { processPair, type ResultRow, type UploadedFile } from "@/lib/process";
import { COLUMNS, copyRowsForExcel, toTsv } from "@/lib/tsv";
import { zipFiles } from "@/lib/zip";

let nextId = 0;
const genId = () => `f${++nextId}`;
let nextPairId = 0;
const genPairId = () => `p${++nextPairId}`;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function Home() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [pairs, setPairs] = useState<PairView[]>([]);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>();
  const [includeHeader, setIncludeHeader] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [fallbackTsv, setFallbackTsv] = useState<string | null>(null);
  const fileMap = useRef(new Map<string, UploadedFile>());

  const photoFiles = useMemo(
    () => files.filter((f) => parseFileName(f.name).kind === "photo"),
    [files],
  );
  const inspectionFiles = useMemo(
    () => files.filter((f) => parseFileName(f.name).kind === "inspection"),
    [files],
  );
  const unclassified = useMemo(
    () => files.filter((f) => parseFileName(f.name).kind === null),
    [files],
  );

  const handleFiles = (newFiles: File[]) => {
    const merged = [...files];
    for (const file of newFiles) {
      if (merged.some((f) => f.name === file.name && f.file.size === file.size)) continue;
      const entry: UploadedFile = { id: genId(), name: file.name, file };
      fileMap.current.set(entry.id, entry);
      merged.push(entry);
    }
    setFiles(merged);
    // 手動修正済みのペアは保持し、それ以外のファイルだけを自動ペアリングし直す
    const lockedPairs = pairs.filter((p) => p.manual);
    const lockedIds = new Set(
      lockedPairs.flatMap((p) =>
        [p.photoId, p.inspectionId].filter((id): id is string => id !== null),
      ),
    );
    const pool = merged.filter((f) => !lockedIds.has(f.id));
    const { pairs: autoPairs } = pairFiles(pool);
    setPairs([
      ...lockedPairs,
      ...autoPairs.map((p) => ({
        id: genPairId(),
        photoId: p.photo?.id ?? null,
        inspectionId: p.inspection?.id ?? null,
        date: p.date,
        ownerDisplay: p.ownerDisplay,
        needsReview: p.needsReview,
      })),
    ]);
    setResults([]);
  };

  const changePair = (pairId: string, side: "photo" | "inspection", fileId: string | null) => {
    setPairs((prev) =>
      prev.map((p) => {
        if (p.id !== pairId) return p;
        const next = {
          ...p,
          [side === "photo" ? "photoId" : "inspectionId"]: fileId,
          needsReview: false,
          manual: true,
        };
        // 表示・結合PDF名・点検日チェックに使うdate/氏名を差し替え後のファイルから再計算
        const repId = next.photoId ?? next.inspectionId;
        const rep = repId ? fileMap.current.get(repId) : undefined;
        if (rep) {
          const meta = parseFileName(rep.name);
          next.date = meta.date;
          next.ownerDisplay = meta.ownerDisplay;
        } else {
          next.date = null;
          next.ownerDisplay = "";
        }
        return next;
      }),
    );
  };

  const run = async () => {
    const targets = pairs.filter((p) => p.photoId);
    if (targets.length === 0) return;
    setProcessing(true);
    setResults([]);
    // メモリピークを抑えるため1ペアずつ逐次処理 (50MB級PDF対策)
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      setProgress({ done: i, total: targets.length, current: p.ownerDisplay });
      const photo = fileMap.current.get(p.photoId!)!;
      const inspection = p.inspectionId ? (fileMap.current.get(p.inspectionId) ?? null) : null;
      const row = await processPair(p.id, p.ownerDisplay, p.date, photo, inspection);
      setResults((prev) => [...prev, row]);
    }
    setProgress(undefined);
    setProcessing(false);
  };

  const onCellChange = (pairId: string, col: number, value: string) => {
    setResults((prev) =>
      prev.map((r) =>
        r.pairId === pairId
          ? { ...r, cells: r.cells.map((c, i) => (i === col ? value : c)) }
          : r,
      ),
    );
  };

  const dataRows = () => {
    const rows = results.filter((r) => !r.error).map((r) => r.cells);
    return includeHeader ? [[...COLUMNS], ...rows] : rows;
  };

  const copy = async () => {
    try {
      await copyRowsForExcel(dataRows());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // クリップボードAPIが使えない環境向けフォールバック
      setFallbackTsv(toTsv(dataRows()));
    }
  };

  const zipAll = async () => {
    setZipping(true);
    try {
      // メモリピークを抑えるため逐次変換。同名の結合PDFには連番を付けてZIP内衝突を防ぐ
      const usedNames = new Map<string, number>();
      const entries: { name: string; data: Uint8Array }[] = [];
      for (const r of results) {
        if (!r.merged) continue;
        const n = (usedNames.get(r.mergedName) ?? 0) + 1;
        usedNames.set(r.mergedName, n);
        const name =
          n === 1 ? r.mergedName : r.mergedName.replace(/\.pdf$/i, ` (${n}).pdf`);
        entries.push({ name, data: new Uint8Array(await r.merged.arrayBuffer()) });
      }
      download(await zipFiles(entries), "結合報告書.zip");
    } catch (e) {
      alert(`ZIPの作成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setZipping(false);
    }
  };

  const mergedCount = results.filter((r) => r.merged).length;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-bold">報告書処理</h1>
      <p className="mt-1 text-sm text-slate-600">
        写真報告書と点検報告書をアップロードすると、結合PDFの作成とExcel転記用テキストの抽出を行います。
      </p>

      <section className="mt-6">
        <Dropzone onFiles={handleFiles} disabled={processing} />
        {unclassified.length > 0 && (
          <p className="mt-2 text-sm text-amber-700">
            種別を判定できなかったファイル (ファイル名に【写真報告書】/【点検報告書】が必要):{" "}
            {unclassified.map((f) => f.name).join(", ")}
          </p>
        )}
      </section>

      {pairs.length > 0 && (
        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              ペアリング結果
              <span className="ml-2 text-sm font-normal text-slate-500">
                {pairs.length}組 (プルダウンで手動修正できます)
              </span>
            </h2>
            <button
              type="button"
              onClick={run}
              disabled={processing || pairs.every((p) => !p.photoId)}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {processing
                ? `処理中… (${(progress?.done ?? 0) + 1}/${progress?.total ?? 0} ${progress?.current ?? ""})`
                : "処理実行"}
            </button>
          </div>
          {/* 種別未判定ファイルも両側のプルダウンに含め、手動で割り当てられるようにする */}
          <PairTable
            pairs={pairs}
            photoFiles={[...photoFiles, ...unclassified]}
            inspectionFiles={[...inspectionFiles, ...unclassified]}
            onChange={changePair}
            disabled={processing}
          />
        </section>
      )}

      {results.length > 0 && (
        <section className="mt-8">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              抽出結果
              <span className="ml-2 text-sm font-normal text-slate-500">
                セルは編集できます (黄=要確認 / 赤=抽出失敗)
              </span>
            </h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={includeHeader}
                  onChange={(e) => setIncludeHeader(e.target.checked)}
                />
                ヘッダー行を含める
              </label>
              <button
                type="button"
                onClick={copy}
                disabled={processing || results.every((r) => r.error)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {copied ? "コピーしました ✓" : "Excel用にコピー"}
              </button>
              <button
                type="button"
                onClick={zipAll}
                disabled={processing || zipping || mergedCount === 0}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
              >
                {zipping ? "ZIP作成中…" : `結合PDFを一括DL (${mergedCount}件)`}
              </button>
            </div>
          </div>
          <ResultsTable
            results={results}
            onCellChange={onCellChange}
            onDownloadRow={(row) => download(row.merged!, row.mergedName)}
          />
        </section>
      )}

      {fallbackTsv !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-3xl rounded-xl bg-white p-5 shadow-xl">
            <h3 className="font-semibold">
              クリップボードにアクセスできませんでした
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              下のテキストを全選択 (Ctrl/Cmd+A) してコピーし、Excelに貼り付けてください。
            </p>
            <textarea
              readOnly
              value={fallbackTsv}
              rows={10}
              onFocus={(e) => e.target.select()}
              className="mt-3 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
            />
            <div className="mt-3 text-right">
              <button
                type="button"
                onClick={() => setFallbackTsv(null)}
                className="rounded-md border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        PDFの解析・結合はすべてブラウザ内で行われます。要約生成時のみ、個人情報を除いた不具合テキストをローカルサーバー経由でGemini
        APIへ送信します (キー未設定時は定型要約)。
      </footer>
    </main>
  );
}
