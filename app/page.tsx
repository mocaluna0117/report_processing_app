"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dropzone } from "@/components/dropzone";
import { PairTable, type PairView } from "@/components/pair-table";
import { ResultsTable } from "@/components/results-table";
import { runLimited } from "@/lib/concurrency";
import { pairFiles, parseFileName } from "@/lib/pairing";
import { warmUpPdfjs } from "@/lib/pdf/extract";
import { processPair, type ResultRow, type UploadedFile } from "@/lib/process";
import { expandRow } from "@/lib/rows";
import { COLUMNS, copyRowsForExcel, toTsv } from "@/lib/tsv";
import type { WorkCategoryEntry } from "@/lib/types";
import { zipFiles } from "@/lib/zip";

/** ペアの同時処理数。待ち時間の大半がAPI応答なので並列化が効く (無料枠の429を避けるため控えめ) */
const PAIR_CONCURRENCY = 3;
/** 同時に扱うPDFの合計バイト数の上限 (50MB級が重なってもメモリを圧迫しないように) */
const BYTE_BUDGET = 140 * 1024 * 1024;

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
  // ペア順を保つためスロット配列で持つ (並列処理の完了順に並ばないようにする)
  const [results, setResults] = useState<(ResultRow | null)[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>();
  const [includeHeader, setIncludeHeader] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const [fallbackTsv, setFallbackTsv] = useState<string | null>(null);
  const fileMap = useRef(new Map<string, UploadedFile>());

  /** 表示・出力用: まだ完了していないスロットを除いたペア順の結果 */
  const rows = useMemo(
    () => results.filter((r): r is ResultRow => r !== null),
    [results],
  );

  // 初回処理時のworker起動待ちを避けるため、表示中にpdfjsを先読みする
  useEffect(() => {
    warmUpPdfjs();
  }, []);

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
    // 処理中の追加投入で表示済みの結果が消えるのを防ぐ
    if (processing) return;
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
    let done = 0;
    setProgress({ done: 0, total: targets.length, current: "" });
    setResults(new Array<ResultRow | null>(targets.length).fill(null));

    // ペアを並列処理する (同時実行数とメモリの両方に上限)。
    // 結果は完了順に追記し、進捗は完了件数で表示する
    const tasks = targets.map((p) => {
      const photo = fileMap.current.get(p.photoId!)!;
      const inspection = p.inspectionId ? (fileMap.current.get(p.inspectionId) ?? null) : null;
      return {
        bytes: photo.file.size + (inspection?.file.size ?? 0),
        run: () => processPair(p.id, p.ownerDisplay, p.date, photo, inspection),
      };
    });

    await runLimited(
      tasks,
      { concurrency: PAIR_CONCURRENCY, byteBudget: BYTE_BUDGET },
      (row, index) => {
        done++;
        setProgress({ done, total: targets.length, current: row.ownerDisplay });
        // 完了したペアの位置にそのまま入れる (ペア順が実行ごとに変わらない)
        setResults((prev) => {
          const next =
            prev.length === targets.length
              ? [...prev]
              : new Array<ResultRow | null>(targets.length).fill(null);
          next[index] = row;
          return next;
        });
      },
    );

    setProgress(undefined);
    setProcessing(false);
  };

  // 工事区分の手動編集 (画像認識の結果を修正・追加・削除)
  const updateCategories = (
    pairId: string,
    fn: (cats: WorkCategoryEntry[]) => WorkCategoryEntry[],
  ) => {
    setResults((prev) =>
      prev.map((r) => (r && r.pairId === pairId ? { ...r, categories: fn(r.categories) } : r)),
    );
  };
  const onCategoryChange = (pairId: string, index: number, value: string) =>
    updateCategories(pairId, (cats) => {
      const next: WorkCategoryEntry[] =
        cats.length > 0 ? [...cats] : [{ value: "", confidence: "ok" }];
      next[index] = { value, confidence: "ok" };
      return next;
    });
  const onCategoryAdd = (pairId: string) =>
    updateCategories(pairId, (cats) => [
      ...(cats.length > 0 ? cats : [{ value: "", confidence: "ok" as const }]),
      { value: "", confidence: "ok" },
    ]);
  const onCategoryRemove = (pairId: string, index: number) =>
    updateCategories(pairId, (cats) => cats.filter((_, i) => i !== index));

  const onCellChange = (pairId: string, col: number, value: string) => {
    setResults((prev) =>
      prev.map((r) =>
        r && r.pairId === pairId
          ? { ...r, cells: r.cells.map((c, i) => (i === col ? value : c)) }
          : r,
      ),
    );
  };

  const rowsOf = (r: ResultRow) =>
    expandRow(r.cells, r.categories.map((c) => c.value));

  // 工事区分の数だけ行を展開した貼り付け用データ
  const dataRows = () => {
    const data = rows.filter((r) => !r.error).flatMap(rowsOf);
    return includeHeader ? [[...COLUMNS], ...data] : data;
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

  // 1行だけコピー (ヘッダー行は付けない: 既存シートの行への貼り付け用)
  const copyRow = async (row: ResultRow) => {
    try {
      await copyRowsForExcel(rowsOf(row));
      setCopiedRowId(row.pairId);
      setTimeout(() => setCopiedRowId((prev) => (prev === row.pairId ? null : prev)), 2500);
    } catch {
      setFallbackTsv(toTsv(rowsOf(row)));
    }
  };

  const zipAll = async () => {
    setZipping(true);
    try {
      // メモリピークを抑えるため逐次変換。同名の結合PDFには連番を付けてZIP内衝突を防ぐ
      const usedNames = new Map<string, number>();
      const entries: { name: string; data: Uint8Array }[] = [];
      for (const r of rows) {
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

  const mergedCount = rows.filter((r) => r.merged).length;

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
                ? `処理中… (${progress?.done ?? 0}/${progress?.total ?? 0} 完了)`
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

      {rows.length > 0 && (
        <section className="mt-8">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              抽出結果
              <span className="ml-2 text-sm font-normal text-slate-500">
                セルは編集できます (黄=要確認 / 赤=抽出失敗)。工事区分の数だけ行が展開されます
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
                disabled={processing || rows.every((r) => r.error)}
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
            results={rows}
            onCellChange={onCellChange}
            onDownloadRow={(row) => download(row.merged!, row.mergedName)}
            onCopyRow={copyRow}
            copiedRowId={copiedRowId}
            onCategoryChange={onCategoryChange}
            onCategoryAdd={onCategoryAdd}
            onCategoryRemove={onCategoryRemove}
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
