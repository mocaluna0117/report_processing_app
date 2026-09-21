"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BlockedReason } from "@/components/blocked-reason";
import { Dropzone } from "@/components/dropzone";
import { FlowSteps } from "@/components/flow-steps";
import { FallbackTsvDialog } from "@/components/fallback-tsv-dialog";
import { MailDialog } from "@/components/mail-dialog";
import { PairTable, type PairView } from "@/components/pair-table";
import { PdfDocumentDialog } from "@/components/pdf-preview";
import { ReportDialog } from "@/components/report-dialog";
import { ResultsTable } from "@/components/results-table";
import { ExamplesDialog } from "@/components/examples-dialog";
import { MoreDetails } from "@/components/more-details";
import { StorageBanner } from "@/components/storage-banner";
import { INSPECTION_SAVE_NOTE, SAVE_PAUSED_TEXT } from "@/lib/privacy-notes";
import { runLimited } from "@/lib/concurrency";
import { downloadBlob as download } from "@/lib/download";
import {
  FILENAME_EXAMPLE,
  type InspectionFlowInput,
  inspectionFlow,
  inspectionRunBlockedReason,
  isFreshInspection,
} from "@/lib/inspection-flow";
import { setNavigationGuard } from "@/lib/navigation-guard";
import { pairFiles, parseFileName } from "@/lib/pairing";
import { warmUpPdfjs } from "@/lib/pdf/extract";
import { processPair, type ResultRow, type UploadedFile } from "@/lib/process";
import { prefetchReportAssets } from "@/lib/report/assets";
import {
  type ResultScope,
  defaultSelection,
  orderRowsByPairs,
  orphanRowIds,
  pairStates,
  reconcilePairs,
  reconcileSelection,
  selectionCounts,
  upsertRow,
  visibleRows,
} from "@/lib/run-plan";
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

/** ペアを選ぶボタン (未処理をすべて選ぶ / 処理済みも含めて選ぶ / 選択を解除) */
const SELECT_BUTTON_CLASS =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

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
  /**
   * 処理した分が積み上がる抽出結果 (pairId が主キー)。
   * ★実行のたびに作り直さない。追加したファイルだけを処理しても前の分が残るようにするため。
   */
  const [results, setResults] = useState<ResultRow[]>([]);
  /** 次の「処理実行」で処理するペア (作業中の意図なので保存しない) */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** 直前の処理実行で対象にしたペア (抽出結果の絞り込みに使う。保存しない) */
  const [lastRun, setLastRun] = useState<ReadonlySet<string>>(new Set());
  const [resultScope, setResultScope] = useState<ResultScope>("all");
  /** 直前のファイル取り込みの内訳 (同じファイルを飛ばしたことを黙って隠さない) */
  const [lastDrop, setLastDrop] = useState<{ added: number; skipped: number } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>();
  const [zipping, setZipping] = useState(false);
  // ダイアログは pairId で開く (results は再生成されるので行オブジェクトを直接持たない)
  const [mailPairId, setMailPairId] = useState<string | null>(null);
  const [reportPairId, setReportPairId] = useState<string | null>(null);
  /** 結合PDFを原寸で見ている行 */
  const [previewPairId, setPreviewPairId] = useState<string | null>(null);
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
  const resultsRef = useRef<ResultRow[]>([]);

  const storage = usePersistence({
    restore: async () => {
      const session = await loadSession();
      for (const f of session.files) fileMap.current.set(f.id, f);
      setFiles(session.files);
      setPairs(session.pairs);
      setResults(session.results);
      // ★既定のチェックは復元し終えてから決める (途中では全部「未処理」に見えてしまう)
      setSelected(defaultSelection(pairStates(session.pairs, session.results)));
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

  /** 処理した分すべて (ペアリング結果と同じ並び)。ペアが無くなった行は末尾に残る */
  const allRows = useMemo(() => orderRowsByPairs(results, pairs), [results, pairs]);
  /** ペアごとの処理の進み具合 (結果が正本。ペアに印は持たせない) */
  const states = useMemo(() => pairStates(pairs, results), [pairs, results]);
  const counts = useMemo(() => selectionCounts(states, selected), [states, selected]);
  /** 画面に出す行 (今回の分だけ / すべて)。コピー・ZIP はこの範囲が対象 */
  const rows = useMemo(
    () => visibleRows(allRows, resultScope, lastRun),
    [allRows, resultScope, lastRun],
  );
  /** どのペアにも紐づかない結果 (以前の版でIDが振り直された分) */
  const orphanIds = useMemo(() => orphanRowIds(results, pairs), [results, pairs]);
  /** 同じ施主・点検日の処理済みがあるペアの数 (再ダウンロードの取り違え対策) */
  const duplicateCount = useMemo(
    () => [...states.values()].filter((v) => v === "duplicate").length,
    [states],
  );
  /** 「未処理をすべて選ぶ」で入る数 (重複の疑いがある分は入れない) */
  const defaultCount = useMemo(() => defaultSelection(states).size, [states]);
  /** 「今回の分」に入る行数 */
  const lastRunCount = useMemo(
    () => allRows.filter((r) => lastRun.has(r.pairId)).length,
    [allRows, lastRun],
  );

  const editors = useRowEditors<ResultRow>((pairId, fn) => {
    setResults((prev) => prev.map((r) => (r.pairId === pairId ? fn(r) : r)));
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
    storage.persist(() => saveResults(results));
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
    setLastDrop({ added: added.length, skipped: newFiles.length - added.length });
    // 手動修正済みのペアは保持し、それ以外のファイルだけを自動ペアリングし直す
    const lockedPairs = pairs.filter((p) => p.manual);
    const lockedIds = new Set(
      lockedPairs.flatMap((p) =>
        [p.photoId, p.inspectionId].filter((id): id is string => id !== null),
      ),
    );
    const pool = merged.filter((f) => !lockedIds.has(f.id));
    const { pairs: autoPairs } = pairFiles(pool);
    // ★同じファイルを指すペアはIDを引き継ぐ (前回の抽出結果・結合PDFが外れないように)
    const nextPairs = [
      ...lockedPairs,
      ...reconcilePairs(
        pairs,
        autoPairs.map((p) => ({
          photoId: p.photo?.id ?? null,
          inspectionId: p.inspection?.id ?? null,
          date: p.date,
          ownerDisplay: p.ownerDisplay,
          needsReview: p.needsReview,
        })),
        genPairId,
      ),
    ];
    setPairs(nextPairs);
    // 今回あらたに現れたペアだけをチェックに足す (自分で外したチェックは戻さない)
    const before = new Set(pairs.map((p) => p.id));
    const nextStates = pairStates(nextPairs, results);
    setSelected((prev) =>
      reconcileSelection({
        previous: prev,
        states: nextStates,
        add: nextPairs.filter((p) => !before.has(p.id)).map((p) => p.id),
      }),
    );
  };

  const changePair = (pairId: string, side: "photo" | "inspection", fileId: string | null) => {
    // 手で直したペアは処理の対象にする (処理済みでも、直したなら取り直したいはず)
    if (fileId !== null) setSelected((prev) => new Set(prev).add(pairId));
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
    const targets = pairs.filter((p) => p.photoId && selected.has(p.id));
    if (targets.length === 0) return;
    // ★処理済みをやり直すときだけ確認する (ふだんの操作は素通りさせる)
    const redo = targets.filter((p) => states.get(p.id) === "processed");
    if (redo.length > 0) {
      const names = redo.slice(0, 3).map((p) => p.ownerDisplay || "施主不明");
      if (
        !confirm(
          `処理済みの${redo.length}件をもう一度処理します。` +
            "直したセル・カナ・完了報告書の設定・結合PDFは新しい結果に置き換わります (取り消せません)。\n" +
            `対象: ${names.join(" / ")}${redo.length > names.length ? ` ほか${redo.length - names.length}件` : ""}\n` +
            "よろしいですか？",
        )
      ) {
        return;
      }
    }

    setProcessing(true);
    setAutoHandover(null);
    setLastDrop(null);
    const ids = targets.map((p) => p.id);
    setLastRun(new Set(ids));
    setResultScope("last");
    let done = 0;
    setProgress({ done: 0, total: targets.length, current: "" });
    // ★前の結果は消さない。消してから中断すると、やり直すまで何も残らないため。
    //   同じペアの行は pairId で置き換わるので、消さなくても重複しない。

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
      (row) => {
        done++;
        completed.push(row);
        setProgress({ done, total: targets.length, current: row.ownerDisplay });
        // 結合PDFは大きいので、ここで1回だけ保存する (結果JSONとは別ストア)。
        // 作られなかったときは前回の分を消す (古いPDFが新しい行に付かないように)
        const blob = row.merged;
        storage.persist(() => saveMergedPdf(row.pairId, blob));
        // 同じペアの行は置き換える (追記すると同じ報告書が二重に並ぶ)
        setResults((prev) => upsertRow(prev, row));
      },
    );

    await syncHandoverDates(completed);

    // 処理した分のチェックを外す (続けて押しても二重に処理しない)
    setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
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
      (row) => latest.find((r) => r.pairId === row.pairId) ?? row,
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
    for (const plan of buildRowStaff(allRows, staffCustomers)) map.set(plan.pairId, plan);
    return map;
  }, [allRows, staffCustomers]);
  /** 「まとめて反映」の対象は、いま表示している行だけ (コピーやZIPと同じ範囲にする) */
  const staffReady = useMemo(
    () =>
      rows.flatMap((r) => {
        const plan = staffPlans.get(r.pairId);
        return plan && plan.updates.length > 0 ? [plan] : [];
      }),
    [rows, staffPlans],
  );

  /** 計画どおりにセルを書き換える。保存は既存の仕組み (results の変化) に任せる */
  const applyStaff = (plans: readonly RowStaffPlan[]) => {
    for (const plan of plans) {
      for (const update of plan.updates) {
        editors.onCellChange(plan.pairId, update.col, update.value);
      }
    }
  };

  // ダイアログは表示範囲を切り替えても閉じないよう、全件から引く
  const mailRow = mailPairId ? (allRows.find((r) => r.pairId === mailPairId) ?? null) : null;
  const reportRow = reportPairId ? (allRows.find((r) => r.pairId === reportPairId) ?? null) : null;
  const previewRow = previewPairId
    ? (allRows.find((r) => r.pairId === previewPairId) ?? null)
    : null;

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
    setResults((prev) => prev.filter((r) => r.pairId !== row.pairId));
    setSelected((prev) => new Set([...prev].filter((id) => id !== row.pairId)));
    setLastRun((prev) => new Set([...prev].filter((id) => id !== row.pairId)));
    if (mailPairId === row.pairId) setMailPairId(null);
    if (reportPairId === row.pairId) setReportPairId(null);
    if (previewPairId === row.pairId) setPreviewPairId(null);

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

  /**
   * ペアリングに残っていない抽出結果を消す。
   * 以前の版はファイルを足すたびにペアのIDを振り直していたので、その名残の行がありうる。
   * ★勝手には消さない (利用者の作業結果なので、押したときだけ消す)。
   */
  const deleteOrphans = async () => {
    if (
      !confirm(
        `ペアリングに残っていない抽出結果 ${orphanIds.length}件を削除します。` +
          "PDFとペアリングは残ります (取り消せません)。よろしいですか？",
      )
    ) {
      return;
    }
    const ids = new Set(orphanIds);
    setResults((prev) => prev.filter((r) => !ids.has(r.pairId)));
    if (!isStorageAvailable()) return;
    try {
      await clearStoredResults(orphanIds);
      storage.refreshHasSaved();
      storage.refreshUsage();
    } catch (e) {
      storage.setStorageError(
        `保存データから削除できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  };

  /** 定期点検の保存データを消して最初の状態に戻す (顧客情報を端末に残さないため) */
  const clearSaved = async () => {
    if (
      !confirm(
        "定期点検のPDF・ペアリング・抽出結果をすべて消します (取り消せません)。" +
          "顧客データ・受付一覧・書体の登録は残ります。よろしいですか？",
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
    setSelected(new Set());
    setLastRun(new Set());
    setResultScope("all");
    setLastDrop(null);
    setMailPairId(null);
    setReportPairId(null);
    setPreviewPairId(null);
    storage.setStorageError(failure);
    storage.refreshHasSaved();
    storage.refreshUsage();
    storage.refreshFontInfo();
  };

  /** 手順バーと「押せない理由」のもと。規則は lib/inspection-flow.ts にまとめてある */
  const flowInput: InspectionFlowInput = {
    restored: storage.restored,
    processing,
    fileCount: files.length,
    unclassifiedCount: unclassified.length,
    counts,
    needsReviewCount: pairs.filter((p) => p.needsReview).length,
    okRowCount: allRows.filter((r) => !r.error).length,
  };

  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        写真報告書と点検報告書をアップロードすると、結合PDFの作成とExcel転記用テキストの抽出を行います。
      </p>

      <FlowSteps
        plan={inspectionFlow(flowInput)}
        ariaLabel="定期点検の手順"
        expanded={isFreshInspection(flowInput)}
        helpHref="/help/inspection"
      />

      <section id="inspection-drop" tabIndex={-1} className="mt-6 scroll-mt-4">
        <Dropzone onFiles={handleFiles} disabled={processing || !storage.restored} example={FILENAME_EXAMPLE} />
        {!storage.restored && (
          <p className="mt-2 text-sm text-slate-500">前回の内容を読み込んでいます…</p>
        )}
        {storage.storageError && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {storage.storageError}
          </p>
        )}
        {lastDrop !== null && lastDrop.added + lastDrop.skipped > 0 && (
          <p className="mt-2 text-sm text-slate-600" aria-live="polite">
            {lastDrop.added}件を取り込みました
            {lastDrop.skipped > 0 &&
              ` (同じファイル${lastDrop.skipped}件は取り込み済みのため飛ばしました)`}
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
        <section id="inspection-pairs" tabIndex={-1} className="mt-6 scroll-mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              ペアリング結果
              <span className="ml-2 text-sm font-normal text-slate-500">
                {`未処理 ${counts.unprocessed}組 / 処理済み ${counts.processed}組`}
                {counts.total > counts.runnable &&
                  ` (写真報告書が無い${counts.total - counts.runnable}組は処理できません)`}
                {" (プルダウンで手動修正できます)"}
              </span>
            </h2>
            <button
              type="button"
              onClick={run}
              disabled={processing || !storage.restored || counts.selected === 0}
              title={
                counts.selected === 0
                  ? "ペアリング結果でチェックを入れてください"
                  : "チェックを入れたペアだけを処理します"
              }
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {processing
                ? `処理中… (${progress?.done ?? 0}/${progress?.total ?? 0} 完了)`
                : counts.selected > 0
                  ? `選択した${counts.selected}件を処理`
                  : "選択した分を処理"}
            </button>
          </div>

          <BlockedReason reason={inspectionRunBlockedReason(flowInput)} className="mb-2" />

          {/* 処理するペアの選び方。「すべて」に処理済みが入ることは文字で書く */}
          <div
            role="group"
            aria-label="ペアの選択"
            className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2"
          >
            <button
              type="button"
              disabled={processing || defaultCount === 0}
              onClick={() => setSelected(defaultSelection(states))}
              className={SELECT_BUTTON_CLASS}
            >
              未処理をすべて選ぶ ({defaultCount})
            </button>
            <button
              type="button"
              disabled={processing || counts.runnable === 0}
              title="処理済みの抽出結果は、処理し直すと新しい結果に置き換わります"
              onClick={() =>
                setSelected(new Set(pairs.filter((p) => p.photoId).map((p) => p.id)))
              }
              className={SELECT_BUTTON_CLASS}
            >
              処理済みも含めて選ぶ ({counts.runnable})
            </button>
            <button
              type="button"
              disabled={processing || counts.selected === 0}
              onClick={() => setSelected(new Set())}
              className={SELECT_BUTTON_CLASS}
            >
              選択を解除
            </button>
            <span className="text-xs text-slate-500" aria-live="polite">
              {counts.selected}組を選択中
            </span>
          </div>

          {duplicateCount > 0 && (
            <div className="mb-2 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900">
              処理済みと同じ施主・点検日のペアが {duplicateCount}組 あります (既定ではチェックを外しています)。
              <MoreDetails size="xs" className="text-orange-900">
                <p>
                  再ダウンロードした同じ報告書かもしれません。処理すると、抽出結果の行がもう1つ増えます。
                </p>
              </MoreDetails>
            </div>
          )}
          {counts.selectedProcessed > 0 && (
            <p className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              処理済みの{counts.selectedProcessed}組が選ばれています。もう一度処理すると、いまの抽出結果は新しい結果に置き換わります。
            </p>
          )}
          {/* 種別未判定ファイルも両側のプルダウンに含め、手動で割り当てられるようにする */}
          <PairTable
            pairs={pairs}
            photoFiles={[...photoFiles, ...unclassified]}
            inspectionFiles={[...inspectionFiles, ...unclassified]}
            states={states}
            selected={selected}
            onToggle={(pairId, next) =>
              setSelected((prev) => {
                const set = new Set(prev);
                if (next) set.add(pairId);
                else set.delete(pairId);
                return set;
              })
            }
            onChange={changePair}
            disabled={processing}
          />
        </section>
      )}

      {allRows.length > 0 && (
        <section id="inspection-results" tabIndex={-1} className="mt-8 scroll-mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              抽出結果
              <span className="ml-2 text-sm font-normal text-slate-500">
                {rows.length}件 — セルは編集できます (黄=要確認 /
                赤=抽出失敗)。工事区分の数だけ行が展開されます
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
          {lastRun.size > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <div
                role="group"
                aria-label="表示する結果"
                className="inline-flex rounded-lg bg-slate-200 p-1 text-sm shadow-inner"
              >
                {(
                  [
                    ["last", `今回の${lastRunCount}件`, "いま処理した分だけを出します"],
                    [
                      "all",
                      `すべて ${allRows.length}件`,
                      "前に処理した分も出します (貼り付け済みの行が混ざります)",
                    ],
                  ] as const
                ).map(([value, text, title]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={resultScope === value}
                    title={title}
                    onClick={() => setResultScope(value)}
                    className={
                      resultScope === value
                        ? "rounded-md bg-white px-3 py-1.5 font-semibold text-slate-900 shadow-sm"
                        : "rounded-md px-3 py-1.5 font-medium text-slate-600 hover:text-slate-900"
                    }
                  >
                    {text}
                  </button>
                ))}
              </div>
              <span className="text-xs text-slate-500">
                「Excel用にコピー」「結合PDFを一括DL」「監督・営業をまとめて反映」は、表示中の行が対象です
              </span>
            </div>
          )}

          {orphanIds.length > 0 && (
            <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              ペアリングに残っていない抽出結果が {orphanIds.length}件 あります。
              <button
                type="button"
                disabled={processing}
                onClick={() => void deleteOrphans()}
                className="ml-2 cursor-pointer underline hover:text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                この{orphanIds.length}件を削除
              </button>
              <MoreDetails size="xs" className="text-amber-900">
                <p>
                  以前の版で作られた分です。コピーやダウンロードはできますが、取り直すにはそのPDFを入れ直してください。
                </p>
              </MoreDetails>
            </div>
          )}

          {rows.length === 0 && (
            <p className="mb-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              今回処理した分はありません。「すべて」に切り替えると前に処理した分が出ます。
            </p>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>要約の書き方を学習: {learning.examples.length}件</span>
            <button
              type="button"
              onClick={() => learning.setOpen(true)}
              className="cursor-pointer rounded-md border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-50"
            >
              一覧・消去
            </button>
          </div>
          <ResultsTable
            results={rows}
            onCellChange={editors.onCellChange}
            onDownloadRow={(row) => download(row.merged!, row.mergedName)}
            onPreviewRow={(row) => setPreviewPairId(row.pairId)}
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

      {previewRow?.merged && (
        <PdfDocumentDialog
          title={previewRow.mergedName}
          subtitle="ダウンロードされるPDFです (写真報告書 → 点検報告書の順に結合したもの)"
          load={async () => previewRow.merged as Blob}
          onDownload={() => download(previewRow.merged as Blob, previewRow.mergedName)}
          onClose={() => setPreviewPairId(null)}
        />
      )}

      {copyState.fallbackTsv !== null && (
        <FallbackTsvDialog text={copyState.fallbackTsv} onClose={copyState.closeFallback} />
      )}

      {/* ★保存と送信の説明は、この欄だけに出す（リード文・フッター・各所の繰り返しはやめた）。
          そのため、まだ何も取り込んでいない画面でも必ず出す */}
      {storage.restored && (
        <StorageBanner
          description={
            storage.canPersist ? (
              <>
                {INSPECTION_SAVE_NOTE.summary}
                <MoreDetails size="xs" summary="くわしく (保存する中身と Gemini へ送るもの)">
                  {INSPECTION_SAVE_NOTE.details.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </MoreDetails>
              </>
            ) : (
              SAVE_PAUSED_TEXT
            )
          }
          detail={learning.examples.length > 0 ? `学習した書き方 ${learning.examples.length}件` : undefined}
          usageBytes={storage.usageBytes}
          fontInfo={storage.fontInfo}
          disabled={processing}
          actions={[
            // ★欄自体は常に出すが、消すものが無いときに「消去」は出さない
            ...(files.length > 0 || rows.length > 0 || storage.hasSaved
              ? [{ label: "保存データを消去", onClick: clearSaved, danger: true }]
              : []),
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

    </main>
  );
}
