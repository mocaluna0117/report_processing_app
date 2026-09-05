"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dropzone } from "@/components/dropzone";
import { FallbackTsvDialog } from "@/components/fallback-tsv-dialog";
import { MailDialog } from "@/components/mail-dialog";
import { PairTable, type PairView } from "@/components/pair-table";
import { ReportDialog } from "@/components/report-dialog";
import { ResultsTable } from "@/components/results-table";
import { ExamplesDialog } from "@/components/examples-dialog";
import { StorageBanner } from "@/components/storage-banner";
import { runLimited } from "@/lib/concurrency";
import { downloadBlob as download } from "@/lib/download";
import { setNavigationGuard } from "@/lib/navigation-guard";
import { pairFiles, parseFileName } from "@/lib/pairing";
import { warmUpPdfjs } from "@/lib/pdf/extract";
import { processPair, type ResultRow, type UploadedFile } from "@/lib/process";
import { prefetchReportAssets } from "@/lib/report/assets";
import { expandResultRow } from "@/lib/rows";
import { useExamples } from "@/lib/use-examples";
import { effectiveFields } from "@/lib/after/customer";
import { loadCustomers, saveReportHandoverDates } from "@/lib/after/customer-store";
import { buildHandoverSync } from "@/lib/after/match-report";
import { type RowStaffPlan, buildRowStaff } from "@/lib/after/match-staff";
import type { Customer } from "@/lib/after/types";
import { HandoverSync } from "@/components/handover-sync";
import {
  clearAll as clearStorage,
  deleteReport,
  clearResults as clearStoredResults,
  collectGarbage,
  hasStoredData,
  isStorageAvailable,
  loadSession,
  saveFiles,
  saveMergedPdf,
  savePairs,
  saveResults,
} from "@/lib/storage";
import { INSPECTION_COLUMN_LABELS, SUMMARY_COL, columnHeaders } from "@/lib/tsv";
import { useExcelCopy } from "@/lib/use-excel-copy";
import { usePersistence } from "@/lib/use-persistence";
import { useRowEditors } from "@/lib/use-row-editors";
import { zipFiles } from "@/lib/zip";

/** ペアの同時処理数。待ち時間の大半がAPI応答なので並列化が効く (無料枠の429を避けるため控えめ) */
const PAIR_CONCURRENCY = 3;
/** 同時に扱うPDFの合計バイト数の上限 (50MB級が重なってもメモリを圧迫しないように) */
const BYTE_BUDGET = 140 * 1024 * 1024;

/**
 * ID は UUID で振る。連番だと、複数タブで同じアプリを開いたときや復元前に採番したときに
 * 同じIDが別のデータに割り当てられ、保存レコードを取り違える (別顧客のPDFで上書きする) ため。
 */
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const genId = () => `f-${uid()}`;
const genPairId = () => `p-${uid()}`;

export default function Home() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [pairs, setPairs] = useState<PairView[]>([]);
  // ペア順を保つためスロット配列で持つ (並列処理の完了順に並ばないようにする)
  const [results, setResults] = useState<(ResultRow | null)[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>();
  const [zipping, setZipping] = useState(false);
  // ダイアログは pairId で開く (results は再生成されるので行オブジェクトを直接持たない)
  const [mailPairId, setMailPairId] = useState<string | null>(null);
  const [reportPairId, setReportPairId] = useState<string | null>(null);
  /**
   * 処理完了時に引渡日を自動で更新した顧客 (pairId → 更新前の顧客データの引渡日)。
   * 「元に戻す」で戻す値を持つため、更新前の値を覚えておく。
   */
  const [autoHandover, setAutoHandover] = useState<Map<string, string | null> | null>(null);
  /** 監督・営業を引くための顧客データ (引渡日の反映と同じものを使い回す) */
  const [staffCustomers, setStaffCustomers] = useState<Customer[]>([]);
  const fileMap = useRef(new Map<string, UploadedFile>());
  /**
   * 最新の抽出結果。処理中でもセルは編集できるので、
   * 引渡日の反映では「処理が終わった時点の行」ではなく直したあとの値を使う。
   */
  const resultsRef = useRef<(ResultRow | null)[]>([]);

  const storage = usePersistence({
    restore: async () => {
      const session = await loadSession();
      for (const f of session.files) fileMap.current.set(f.id, f);
      setFiles(session.files);
      setPairs(session.pairs);
      setResults(session.results);
      // 結果に紐づかない前回の結合PDFを掃除して容量を戻す
      void collectGarbage(new Set(session.results.map((r) => r.pairId))).catch(() => {});
      const partialErrors = [...session.partialErrors];
      try {
        await learning.restore();
      } catch (e) {
        partialErrors.push(`学習した書き方: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { partialErrors };
    },
    hasSaved: hasStoredData,
  });
  /** 学習した書き方 (伏せ字済みの不具合項目 → 利用者が書いた点検内容) */
  const learning = useExamples<ResultRow>({
    kind: "inspection",
    inputOf: (row) => row.redactedDefects ?? "",
    outputLabel: "点検内容",
    storage,
  });
  const copyState = useExcelCopy();

  /** 表示・出力用: まだ完了していないスロットを除いたペア順の結果 */
  const rows = useMemo(() => results.filter((r): r is ResultRow => r !== null), [results]);

  const editors = useRowEditors<ResultRow>((pairId, fn) => {
    setResults((prev) => prev.map((r) => (r && r.pairId === pairId ? fn(r) : r)));
  });

  // 初回処理時のworker起動待ちを避けるため、表示中にpdfjsを先読みする
  useEffect(() => {
    warmUpPdfjs();
  }, []);

  // 監督・営業の反映に使う顧客データ。処理の完了後にも読み直す
  // (処理中に引渡日を自動反映しているため)
  useEffect(() => {
    if (processing || !isStorageAvailable()) return;
    let alive = true;
    loadCustomers()
      .then((list) => {
        if (alive) setStaffCustomers(list);
      })
      .catch(() => {
        if (alive) setStaffCustomers([]);
      });
    return () => {
      alive = false;
    };
  }, [processing]);

  // 処理中に画面を切り替えると未完了分が失われるので確認を出す
  useEffect(() => {
    setNavigationGuard(
      processing ? "処理中です。画面を切り替えると未完了分の結果が失われます。移動しますか？" : null,
    );
    return () => setNavigationGuard(null);
  }, [processing]);

  // 引渡日の反映で最新の値を使えるようにする (state は非同期処理の中では古いため)
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  // ペアリングと結果は変更のたびに保存する (PDF本体は取り込み時に1回だけ保存)
  useEffect(() => {
    storage.persist(() => savePairs(pairs));
  }, [pairs, storage.canPersist]);

  useEffect(() => {
    storage.persist(() => saveResults(results.filter((r): r is ResultRow => r !== null)));
  }, [results, storage.canPersist]);

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
    // 追加分のPDFだけを保存する (既存分は取り込み時に保存済み)
    const added = merged.filter((m) => !files.some((f) => f.id === m.id));
    storage.persist(() => saveFiles(added));
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
    setAutoHandover(null);
    // 今回処理する分の結合PDFだけを消す (他タブ・前回セッションの分を巻き込まない)
    storage.persist(() => clearStoredResults(targets.map((p) => p.id)));
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
        run: () =>
          processPair(p.id, p.ownerDisplay, p.date, photo, inspection, learning.examples),
      };
    });

    // 引渡日の反映に使う (state は非同期処理の中では古い値のままなので、ここで集める)
    const completed: ResultRow[] = [];

    await runLimited(
      tasks,
      { concurrency: PAIR_CONCURRENCY, byteBudget: BYTE_BUDGET },
      (row, index) => {
        done++;
        completed.push(row);
        setProgress({ done, total: targets.length, current: row.ownerDisplay });
        // 結合PDFは大きいので、ここで1回だけ保存する (結果JSONとは別ストア)
        if (row.merged) {
          const blob = row.merged;
          storage.persist(() => saveMergedPdf(row.pairId, blob));
        }
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

    await syncHandoverDates(completed);

    setProgress(undefined);
    setProcessing(false);
  };

  /**
   * 顧客データの引渡日を、報告書の値で自動更新する (報告書の方が確かなため)。
   * 照合が確実なものだけを書き、要確認のものは画面のボタンで確認してもらう。
   */
  const syncHandoverDates = async (completed: ResultRow[]) => {
    if (!isStorageAvailable()) return;
    const customers = await loadCustomers().catch(() => []);
    if (customers.length === 0) return;
    // 処理中に直されたセル (引渡日・氏名・住所・PJ) を反映するため、最新の行に差し替える
    const latest = resultsRef.current;
    const current = completed.map(
      (row) => latest.find((r) => r?.pairId === row.pairId) ?? row,
    );
    const targets = buildHandoverSync(current, customers).filter((i) => i.autoApplicable);
    if (targets.length === 0) return;
    try {
      await saveReportHandoverDates(
        targets.flatMap((i) =>
          i.match.customer && i.reportDate
            ? [{ id: i.match.customer.id, date: i.reportDate, pj: i.pj }]
            : [],
        ),
      );
      // 「元に戻す」用に、更新前の引渡日を覚えておく
      setAutoHandover(
        new Map(
          targets.map((i) => [
            i.pairId,
            i.match.customer ? (effectiveFields(i.match.customer).handoverDate ?? null) : null,
          ]),
        ),
      );
    } catch (e) {
      storage.setStorageError(
        `引渡日を顧客データへ反映できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  };

  /**
   * お客様の情報から監督・営業を引く計画 (PJの上8桁で突き合わせる)。
   * 空欄のセルにだけ入れ、値が食い違うときは入れない (lib/after/match-staff.ts)。
   */
  const staffPlans = useMemo(() => {
    const map = new Map<string, RowStaffPlan>();
    for (const plan of buildRowStaff(rows, staffCustomers)) map.set(plan.pairId, plan);
    return map;
  }, [rows, staffCustomers]);
  const staffReady = useMemo(
    () => [...staffPlans.values()].filter((p) => p.updates.length > 0),
    [staffPlans],
  );

  /** 計画どおりにセルを書き換える。保存は既存の仕組み (results の変化) に任せる */
  const applyStaff = (plans: readonly RowStaffPlan[]) => {
    for (const plan of plans) {
      for (const update of plan.updates) {
        editors.onCellChange(plan.pairId, update.col, update.value);
      }
    }
  };

  const mailRow = mailPairId ? (rows.find((r) => r.pairId === mailPairId) ?? null) : null;
  const reportRow = reportPairId ? (rows.find((r) => r.pairId === reportPairId) ?? null) : null;

  const rowsOf = (r: ResultRow) => expandResultRow(r);

  // 工事区分の数だけ行を展開した貼り付け用データ
  const dataRows = () => {
    const data = rows.filter((r) => !r.error).flatMap(rowsOf);
    return copyState.includeHeader
      ? [columnHeaders(INSPECTION_COLUMN_LABELS), ...data]
      : data;
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
        const name = n === 1 ? r.mergedName : r.mergedName.replace(/\.pdf$/i, ` (${n}).pdf`);
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

  /**
   * 1件の抽出結果を削除する。
   *
   * その報告書のPDF・ペアリング・結合PDFもまとめて消す。抽出結果だけを消すと
   * 次の「処理実行」で戻ってきてしまい、ファイルだけ残すと次にファイルを足したときの
   * 再ペアリングで復活するため。
   */
  const deleteRow = async (row: ResultRow) => {
    const pair = pairs.find((p) => p.id === row.pairId);
    // 他のペアがまだ使っているファイルは消さない
    const stillUsed = new Set(
      pairs
        .filter((p) => p.id !== row.pairId)
        .flatMap((p) => [p.photoId, p.inspectionId])
        .filter((id): id is string => id !== null),
    );
    const fileIds = [pair?.photoId, pair?.inspectionId].filter(
      (id): id is string => typeof id === "string" && !stillUsed.has(id),
    );
    const names = fileIds
      .map((id) => fileMap.current.get(id)?.name)
      .filter((name): name is string => Boolean(name));
    if (
      !confirm(
        `${row.ownerDisplay || "この報告書"} の抽出結果を削除します。` +
          `アップロードしたPDF・ペアリング・結合PDFも消えます (取り消せません)。` +
          `${names.length > 0 ? `\n対象のファイル: ${names.join(", ")}` : ""}\nよろしいですか？`,
      )
    ) {
      return;
    }

    for (const id of fileIds) fileMap.current.delete(id);
    setFiles((prev) => prev.filter((f) => !fileIds.includes(f.id)));
    setPairs((prev) => prev.filter((p) => p.id !== row.pairId));
    setResults((prev) => prev.filter((r) => r?.pairId !== row.pairId));
    if (mailPairId === row.pairId) setMailPairId(null);
    if (reportPairId === row.pairId) setReportPairId(null);

    if (!isStorageAvailable()) return;
    try {
      // 保存側は state の変更に任せず明示的に消す (最後の1件は空配列で上書きできないため)
      await deleteReport(row.pairId, fileIds);
      storage.refreshHasSaved();
      storage.refreshUsage();
    } catch (e) {
      storage.setStorageError(
        `保存データから削除できませんでした (${e instanceof Error ? e.message : String(e)})。` +
          "再読み込みすると戻る場合があります",
      );
    }
  };

  /** 定期点検の保存データを消して最初の状態に戻す (顧客情報を端末に残さないため) */
  const clearSaved = async () => {
    if (
      !confirm(
        "定期点検で保存されているPDF・ペアリング・抽出結果をすべて消去します。取り消せません。" +
          "(アフターメンテナンスの顧客データ・受付一覧、完了報告書の書体の登録は残ります)よろしいですか？",
      )
    ) {
      return;
    }
    let failure: string | null = null;
    if (isStorageAvailable()) {
      try {
        await clearStorage();
      } catch (e) {
        failure = `保存データの消去に失敗しました (${e instanceof Error ? e.message : String(e)})。ブラウザの設定からサイトデータを削除してください`;
      }
    }
    // 消去に失敗しても、画面とメモリ上の顧客情報は必ず消す
    setAutoHandover(null);
    fileMap.current.clear();
    setFiles([]);
    setPairs([]);
    setResults([]);
    setMailPairId(null);
    setReportPairId(null);
    storage.setStorageError(failure);
    storage.refreshHasSaved();
    storage.refreshUsage();
    storage.refreshFontInfo();
  };

  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        写真報告書と点検報告書をアップロードすると、結合PDFの作成とExcel転記用テキストの抽出を行います。
      </p>

      <section className="mt-6">
        <Dropzone onFiles={handleFiles} disabled={processing || !storage.restored} />
        {!storage.restored && (
          <p className="mt-2 text-sm text-slate-500">前回の内容を読み込んでいます…</p>
        )}
        {storage.storageError && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {storage.storageError}
          </p>
        )}
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
              disabled={processing || !storage.restored || pairs.every((p) => !p.photoId)}
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
                  checked={copyState.includeHeader}
                  onChange={(e) => copyState.setIncludeHeader(e.target.checked)}
                />
                ヘッダー行を含める
              </label>
              <button
                type="button"
                onClick={() => copyState.copyAll(dataRows())}
                disabled={processing || rows.every((r) => r.error)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {copyState.copied ? "コピーしました ✓" : "Excel用にコピー"}
              </button>
              {staffCustomers.length > 0 && (
                <button
                  type="button"
                  onClick={() => applyStaff(staffReady)}
                  disabled={processing || staffReady.length === 0}
                  title="お客様の情報 (アフターメンテナンス) から、PJの上8桁が一致する監督・営業を空欄の行に入れます"
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  監督・営業をまとめて反映 ({staffReady.length}件)
                </button>
              )}
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
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>要約の書き方を学習: {learning.examples.length}件</span>
            <button
              type="button"
              onClick={() => learning.setOpen(true)}
              className="cursor-pointer rounded-md border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-50"
            >
              一覧・消去
            </button>
            <span>
              行の「この書き方を学習」で覚えた文体を、次に処理する報告書の要約の手本として送ります
              (伏せ字にした本文だけ。キー未設定時の定型要約には使われません)
            </span>
          </div>
          <ResultsTable
            results={rows}
            onCellChange={editors.onCellChange}
            onDownloadRow={(row) => download(row.merged!, row.mergedName)}
            onCopyRow={(row) => copyState.copyRow(row.pairId, rowsOf(row))}
            copiedRowId={copyState.copiedRowId}
            onCategoryChange={editors.onCategoryChange}
            onCategoryAdd={editors.onCategoryAdd}
            onCategoryRemove={editors.onCategoryRemove}
            onCategorySummaryChange={editors.onCategorySummaryChange}
            onOpenMail={(row) => setMailPairId(row.pairId)}
            onOpenReport={(row) => setReportPairId(row.pairId)}
            onPrefetchReport={prefetchReportAssets}
            columnLabels={INSPECTION_COLUMN_LABELS}
            {...(processing
              ? {}
              : { onDeleteRow: (row: ResultRow) => void deleteRow(row) })}
            deleteTitle="この報告書の抽出結果・PDF・ペアリングを削除します"
            renderRowActions={(row) => {
              const state = learning.learnState(row);
              const staff = staffPlans.get(row.pairId);
              return (
                <>
                {staffCustomers.length > 0 && (
                  <button
                    type="button"
                    disabled={!staff || staff.updates.length === 0}
                    title={staff?.reason}
                    onClick={() => staff && applyStaff([staff])}
                    className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium ${
                      staff && staff.updates.length > 0
                        ? "cursor-pointer border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                        : "cursor-default border-slate-200 bg-slate-50 text-slate-400"
                    }`}
                  >
                    監督・営業を反映
                  </button>
                )}
                <button
                  type="button"
                  disabled={state.disabled}
                  title={state.title}
                  onClick={() => void learning.learn(row)}
                  className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium ${
                    state.disabled
                      ? "cursor-default border-slate-200 bg-slate-50 text-slate-400"
                      : "cursor-pointer border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100"
                  }`}
                >
                  {state.label}
                </button>
                </>
              );
            }}
          />
        </section>
      )}

      {rows.some((r) => !r.error) && (
        <HandoverSync rows={rows} processing={processing} autoApplied={autoHandover} />
      )}

      {mailRow && (
        <MailDialog
          row={mailRow}
          onKanaChange={editors.onKanaChange}
          onClose={() => setMailPairId(null)}
        />
      )}

      {reportRow && (
        <ReportDialog
          row={reportRow}
          onOptionsChange={editors.onReportOptionsChange}
          onKanaChange={editors.onKanaChange}
          onCellChange={editors.onCellChange}
          onContactsChange={editors.onContactsChange}
          onCategorySummaryChange={editors.onCategorySummaryChange}
          onSummaryChange={(pairId, summary) =>
            editors.onCellChange(pairId, SUMMARY_COL, summary)
          }
          onClose={() => {
            setReportPairId(null);
            storage.refreshFontInfo();
          }}
        />
      )}

      {copyState.fallbackTsv !== null && (
        <FallbackTsvDialog text={copyState.fallbackTsv} onClose={copyState.closeFallback} />
      )}

      {(files.length > 0 ||
        rows.length > 0 ||
        storage.hasSaved ||
        storage.fontInfo ||
        learning.examples.length > 0) && (
        <StorageBanner
          description={
            storage.canPersist
              ? "アップロードしたPDF・ペアリング・抽出結果はこのブラウザ内に保存され、再読み込みしても残ります (サーバーには送信されません)。作業が終わったら消去してください。"
              : "このタブでは保存を停止しています (再読み込みすると復元を試み直せます)。以前の保存データが端末に残っている場合は消去できます。"
          }
          detail={
            learning.examples.length > 0
              ? `学習した書き方 ${learning.examples.length}件 (伏せ字にした本文だけを保存し、「保存データを消去」では消えません)`
              : undefined
          }
          usageBytes={storage.usageBytes}
          fontInfo={storage.fontInfo}
          disabled={processing}
          actions={[
            { label: "保存データを消去", onClick: clearSaved, danger: true },
            ...(learning.examples.length > 0
              ? [
                  {
                    label: "学習した書き方を消去",
                    onClick: () => void learning.clearExamples(),
                    danger: true,
                  },
                ]
              : []),
          ]}
          onClearFont={storage.clearFont}
        />
      )}

      {learning.open && (
        <ExamplesDialog
          examples={learning.examples}
          labels={{ input: "不具合項目", output: "点検内容" }}
          onDelete={learning.deleteExample}
          onClearAll={() => void learning.clearExamples()}
          onImport={learning.importExamples}
          onClose={() => learning.setOpen(false)}
        />
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        PDFの解析・結合・完了報告書 (Excel・PDF) の作成はすべてブラウザ内で行われます。Gemini APIへ送るのは、
        個人情報を除いた不具合テキスト (要約用)・署名と電話番号を切り落とした点検シート画像 (工事区分用)・
        施主名の漢字 (カナ読み用) のみです (キー未設定時は定型要約・手動選択になります)。
      </footer>
    </main>
  );
}
