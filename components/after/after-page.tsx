"use client";

import { useEffect, useMemo, useState } from "react";
import { AfterIntake } from "@/components/after/after-intake";
import { CustomerCard } from "@/components/after/customer-card";
import { CustomerImport, type CustomerSummary } from "@/components/after/customer-import";
import { CustomerSearch } from "@/components/after/customer-search";
import { InquiryExamplesDialog } from "@/components/after/inquiry-examples-dialog";
import { FallbackTsvDialog } from "@/components/fallback-tsv-dialog";
import { MailDialog } from "@/components/mail-dialog";
import { ReportDialog } from "@/components/report-dialog";
import { ResultsTable } from "@/components/results-table";
import { StorageBanner } from "@/components/storage-banner";
import { createAfterCase } from "@/lib/after/case";
import { applyEdits, effectiveFields, needsReview, resetEdits } from "@/lib/after/customer";
import {
  clearCustomers,
  loadCustomers,
  saveCustomerEdits,
  saveImport,
  type ImportReport,
} from "@/lib/after/customer-store";
import {
  clearInquiryExamples,
  deleteInquiryExample,
  loadInquiryExamples,
  mergeInquiryExamples,
  upsertInquiryExample,
} from "@/lib/after/examples-store";
import { parseCustomerFile } from "@/lib/after/import";
import {
  AFTER_HIDDEN_COLUMNS,
  AFTER_SELECT_COLUMNS,
} from "@/lib/after/reception";
import { inquiryExampleOf, summarizeInquiry } from "@/lib/after/summarize-inquiry";
import type { AfterCase, Customer, CustomerFields } from "@/lib/after/types";
import { setNavigationGuard } from "@/lib/navigation-guard";
import { prefetchReportAssets } from "@/lib/report/assets";
import { dropColumns, expandResultRow } from "@/lib/rows";
import { recordSummary } from "@/lib/summary";
import { type InquiryExample, upsertExample } from "@/lib/summarize/examples";
import {
  clearAfterCases,
  isStorageAvailable,
  loadAfterCases,
  saveAfterCases,
} from "@/lib/storage";
import { COLUMNS, RECEPTION_TYPE_COL, SUMMARY_COL } from "@/lib/tsv";
import { useExcelCopy } from "@/lib/use-excel-copy";
import { usePersistence } from "@/lib/use-persistence";
import { useRowEditors } from "@/lib/use-row-editors";

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function AfterPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [cases, setCases] = useState<AfterCase[]>([]);
  const [query, setQuery] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inquiryText, setInquiryText] = useState("");
  /** 学習した書き方 (伏せ字済みの受付メモ → 利用者が書いた本文) */
  const [examples, setExamples] = useState<InquiryExample[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerNotice, setRegisterNotice] = useState<string | null>(null);
  const [mailCaseId, setMailCaseId] = useState<string | null>(null);
  const [reportCaseId, setReportCaseId] = useState<string | null>(null);

  const storage = usePersistence({
    restore: async () => {
      const partialErrors: string[] = [];
      try {
        setCustomers(await loadCustomers());
      } catch (e) {
        partialErrors.push(`顧客データ: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        setCases(await loadAfterCases());
      } catch (e) {
        partialErrors.push(`受付一覧: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        setExamples(await loadInquiryExamples());
      } catch (e) {
        partialErrors.push(`学習した書き方: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { partialErrors };
    },
    hasSaved: async () => (await loadAfterCases()).length > 0,
  });
  const copyState = useExcelCopy();
  const editors = useRowEditors<AfterCase>((pairId, fn) => {
    setCases((prev) => prev.map((c) => (c.pairId === pairId ? fn(c) : c)));
  });

  // 受付一覧は変更のたびに保存する (顧客データは取り込み・手直しの時だけ書く)
  useEffect(() => {
    storage.persist(() => saveAfterCases(cases));
  }, [cases, storage.canPersist]);

  // 要約の途中で画面を切り替えると受付が消えるので確認を出す
  useEffect(() => {
    setNavigationGuard(
      registering ? "受付を登録中です。画面を切り替えると失われます。移動しますか？" : null,
    );
    return () => setNavigationGuard(null);
  }, [registering]);

  const selected = useMemo(
    () => customers.find((c) => c.id === selectedId) ?? null,
    [customers, selectedId],
  );
  const summary: CustomerSummary = useMemo(() => {
    const bySource = { suketto: 0, dx: 0 };
    let lastImportedAt: number | null = null;
    let review = 0;
    for (const c of customers) {
      bySource[c.source] += 1;
      if (lastImportedAt === null || c.importedAt > lastImportedAt) lastImportedAt = c.importedAt;
      if (needsReview(c)) review += 1;
    }
    return { total: customers.length, bySource, lastImportedAt, needsReview: review };
  }, [customers]);

  const importFile = async (file: File) => {
    setImporting(true);
    setImportError(null);
    setImportReport(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseCustomerFile(bytes, file.name);
      const replacing = parsed.source === "suketto" && summary.bySource.suketto > 0;
      if (
        replacing &&
        !confirm(
          `助っ人クラウドの顧客データ ${summary.bySource.suketto}件 を、` +
            `このファイルの ${parsed.customers.length}件 で置き換えます。よろしいですか？`,
        )
      ) {
        return;
      }
      const report = await saveImport(parsed);
      setImportReport(report);
      setCustomers(await loadCustomers());
      storage.refreshUsage();
    } catch (e) {
      setImportError(
        `顧客データを取り込めませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setImporting(false);
    }
  };

  const editCustomer = async (patch: Partial<CustomerFields>) => {
    if (!selected) return;
    // 画面はすぐ更新し、保存は裏で行う
    const next = applyEdits(selected, patch, Date.now());
    setCustomers((prev) => prev.map((c) => (c.id === next.id ? next : c)));
    try {
      await saveCustomerEdits(selected.id, patch);
    } catch (e) {
      storage.setStorageError(
        `顧客データの手直しを保存できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  };

  const resetCustomer = async () => {
    if (!selected) return;
    const next = resetEdits(selected, Date.now());
    setCustomers((prev) => prev.map((c) => (c.id === next.id ? next : c)));
    try {
      await saveCustomerEdits(
        selected.id,
        Object.fromEntries(
          Object.keys(selected.edits).map((key) => [
            key,
            selected.imported[key as keyof CustomerFields],
          ]),
        ) as Partial<CustomerFields>,
      );
    } catch {
      // 保存できなくても画面上は戻す (次回の手直しで書き直せる)
    }
  };

  const deleteCustomers = async () => {
    if (
      !confirm(
        `顧客データ ${customers.length}件 をこの端末から削除します。取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    try {
      await clearCustomers();
    } catch (e) {
      storage.setStorageError(
        `顧客データを削除できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    setCustomers([]);
    setSelectedId(null);
    setImportReport(null);
    storage.refreshUsage();
  };

  const register = async () => {
    if (!selected || !inquiryText.trim()) return;
    setRegistering(true);
    setRegisterError(null);
    setRegisterNotice(null);
    try {
      const result = await summarizeInquiry(inquiryText, selected, { examples });
      const row = createAfterCase({
        id: `c-${uid()}`,
        customer: selected,
        inquiryText,
        redactedInquiry: result.redacted,
        summary: result.summary,
        engine: result.engine,
        summaryFailed: !result.summary,
        warnings: result.warning ? [result.warning] : [],
      });
      setCases((prev) => [...prev, row]);
      setInquiryText("");
      if (!result.summary) {
        // 受付メモに不具合も依頼も書かれていなかった場合。空欄のまま気づかれないと困るのでここでも知らせる
        setRegisterNotice(
          result.warning
            ? `「アフター受付内容」が空欄です — ${result.warning.replace(/^要約API:\s*/, "")}`
            : "受付内容を要約できなかったため「アフター受付内容」が空欄です。受付一覧の欄に直接入力してください",
        );
      }
    } catch (e) {
      setRegisterError(
        `受付を登録できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setRegistering(false);
    }
  };

  const exampleById = useMemo(
    () => new Map(examples.map((e) => [e.id, e])),
    [examples],
  );

  /** 保存に失敗しても作業は止めず、画面内の状態だけは進める */
  const applyExamples = async (
    run: () => Promise<InquiryExample[]>,
    fallback: (list: InquiryExample[]) => InquiryExample[],
  ) => {
    if (!isStorageAvailable()) {
      setExamples(fallback);
      return;
    }
    try {
      setExamples(await run());
      storage.refreshUsage();
    } catch (e) {
      storage.setStorageError(
        `学習した書き方を保存できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  };

  /** 今のアフター受付内容を「この書き方」として覚える (本文・メモとも伏せ字にして保存する) */
  const learn = async (row: AfterCase) => {
    const { input, output } = inquiryExampleOf(row);
    if (!output || !input) return;
    const now = Date.now();
    const example: InquiryExample = {
      id: row.pairId,
      input,
      output,
      createdAt: exampleById.get(row.pairId)?.createdAt ?? now,
      updatedAt: now,
    };
    await applyExamples(
      () => upsertInquiryExample(example),
      (list) => upsertExample(list, example),
    );
  };

  const deleteExample = (id: string) =>
    applyExamples(
      () => deleteInquiryExample(id),
      (list) => list.filter((e) => e.id !== id),
    );

  const importExamples = (incoming: InquiryExample[]) =>
    applyExamples(
      () => mergeInquiryExamples(incoming),
      (list) => list,
    );

  const clearExamples = async () => {
    if (!confirm(`学習した書き方 ${examples.length}件 をすべて消去します。よろしいですか？`)) {
      return;
    }
    try {
      await clearInquiryExamples();
    } catch {
      // 消せなくても画面からは外す (次の保存で上書きされる)
    }
    setExamples([]);
    setExamplesOpen(false);
    storage.refreshUsage();
  };

  /** 学習ボタンの状態 (未学習 / 学習済み / 手直しがあって再学習できる) */
  const learnState = (row: AfterCase) => {
    const { output } = inquiryExampleOf(row);
    if (!output) {
      return { label: "この書き方を学習", disabled: true, title: "アフター受付内容が空欄です" };
    }
    const saved = exampleById.get(row.pairId);
    if (!saved) {
      // 要約をそのまま使っている行も、確認として学習できる
      const edited = row.originalSummary !== undefined && row.originalSummary !== recordSummary(row);
      return {
        label: "この書き方を学習",
        disabled: false,
        title: edited
          ? "手直しした書き方を、次回以降の要約の手本にします"
          : "この受付内容の書き方を、次回以降の要約の手本にします (要約のまま)",
      };
    }
    if (saved.output === output) {
      return { label: "学習済み ✓", disabled: true, title: "この書き方を手本にしています" };
    }
    return { label: "再学習", disabled: false, title: "直したあとの書き方で覚え直します" };
  };

  const deleteCase = (row: AfterCase) => {
    if (!confirm(`${row.ownerDisplay} の受付を削除します。よろしいですか？`)) return;
    setCases((prev) => prev.filter((c) => c.pairId !== row.pairId));
    if (mailCaseId === row.pairId) setMailCaseId(null);
    if (reportCaseId === row.pairId) setReportCaseId(null);
  };

  const clearCases = async () => {
    if (!confirm("受付一覧をすべて消去します。取り消せません。よろしいですか？")) return;
    if (isStorageAvailable()) {
      try {
        await clearAfterCases();
      } catch (e) {
        storage.setStorageError(
          `受付一覧を消去できませんでした (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
    setCases([]);
    setMailCaseId(null);
    setReportCaseId(null);
    storage.refreshHasSaved();
    storage.refreshUsage();
  };

  // 備考欄 (定期点検専用) を除いて貼り付ける
  const rowsOf = (row: AfterCase) => dropColumns(expandResultRow(row), AFTER_HIDDEN_COLUMNS);

  const copyAll = async () => {
    const missing = cases.filter((c) => !c.cells[RECEPTION_TYPE_COL]).length;
    if (
      missing > 0 &&
      !confirm(`受付種別が未選択の受付が${missing}件あります。このままコピーしますか？`)
    ) {
      return;
    }
    const data = cases.flatMap(rowsOf);
    const header = dropColumns([[...COLUMNS]], AFTER_HIDDEN_COLUMNS);
    await copyState.copyAll(copyState.includeHeader ? [...header, ...data] : data);
  };

  const mailRow = mailCaseId ? (cases.find((c) => c.pairId === mailCaseId) ?? null) : null;
  const reportRow = reportCaseId ? (cases.find((c) => c.pairId === reportCaseId) ?? null) : null;

  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        お問い合わせを受けた補修の受付です。お客様を選び、コールセンターの受付内容を貼り付けると、
        Excel転記用の行・メール文・完了報告書を作れます。
      </p>

      {storage.storageError && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {storage.storageError}
        </p>
      )}

      <div className="mt-6 space-y-4">
        <CustomerImport
          summary={summary}
          report={importReport}
          importing={importing}
          error={importError}
          onImport={importFile}
          onDelete={deleteCustomers}
          onShowReview={() => {
            setReviewOnly(true);
            setQuery("");
          }}
        />

        {customers.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-2">
            <CustomerSearch
              customers={customers}
              query={query}
              onQueryChange={setQuery}
              selectedId={selectedId}
              onSelect={setSelectedId}
              reviewOnly={reviewOnly}
              onReviewOnlyChange={setReviewOnly}
            />
            {selected ? (
              <CustomerCard customer={selected} onChange={editCustomer} onReset={resetCustomer} />
            ) : (
              <section className="flex items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-400">
                左の一覧からお客様を選ぶと、内容を確認・修正できます
              </section>
            )}
          </div>
        )}

        {customers.length > 0 && (
          <AfterIntake
            customer={selected}
            value={inquiryText}
            onChange={setInquiryText}
            onSubmit={register}
            busy={registering}
            error={registerError}
            notice={registerNotice}
          />
        )}
        {customers.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>要約の書き方を学習: {examples.length}件</span>
            <button
              type="button"
              onClick={() => setExamplesOpen(true)}
              className="cursor-pointer rounded-md border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-50"
            >
              一覧・消去
            </button>
            <span>
              受付一覧の「この書き方を学習」で覚えた文体を、次の要約の手本として送ります
              (伏せ字にした本文だけ。キー未設定時の定型要約には使われません)
            </span>
          </div>
        )}
      </div>

      {cases.length > 0 && (
        <section className="mt-8">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              受付一覧
              <span className="ml-2 text-sm font-normal text-slate-500">
                {cases.length}件 — セルは編集できます (黄=要確認)。受付種別を選んでからコピーしてください
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
                onClick={copyAll}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                {copyState.copied ? "コピーしました ✓" : "Excel用にコピー"}
              </button>
              <button
                type="button"
                onClick={clearCases}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
              >
                受付一覧を消去
              </button>
            </div>
          </div>
          <ResultsTable
            results={cases}
            rowLabel="お客様"
            hiddenColumns={AFTER_HIDDEN_COLUMNS}
            selectColumns={AFTER_SELECT_COLUMNS}
            showPdf={false}
            onCellChange={editors.onCellChange}
            onCopyRow={(row) => copyState.copyRow(row.pairId, rowsOf(row))}
            copiedRowId={copyState.copiedRowId}
            onCategoryChange={editors.onCategoryChange}
            onCategoryAdd={editors.onCategoryAdd}
            onCategoryRemove={editors.onCategoryRemove}
            onCategorySummaryChange={editors.onCategorySummaryChange}
            onOpenMail={(row) => setMailCaseId(row.pairId)}
            onOpenReport={(row) => setReportCaseId(row.pairId)}
            onPrefetchReport={prefetchReportAssets}
            onDeleteRow={deleteCase}
            renderRowActions={(row) => {
              const state = learnState(row);
              return (
                <button
                  type="button"
                  disabled={state.disabled}
                  title={state.title}
                  onClick={() => void learn(row)}
                  className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium ${
                    state.disabled
                      ? "cursor-default border-slate-200 bg-slate-50 text-slate-400"
                      : "cursor-pointer border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100"
                  }`}
                >
                  {state.label}
                </button>
              );
            }}
          />
        </section>
      )}

      {mailRow && (
        <MailDialog
          row={mailRow}
          onKanaChange={editors.onKanaChange}
          onClose={() => setMailCaseId(null)}
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
            setReportCaseId(null);
            storage.refreshFontInfo();
          }}
        />
      )}

      {copyState.fallbackTsv !== null && (
        <FallbackTsvDialog text={copyState.fallbackTsv} onClose={copyState.closeFallback} />
      )}

      {examplesOpen && (
        <InquiryExamplesDialog
          examples={examples}
          onDelete={(id) => void deleteExample(id)}
          onClearAll={() => void clearExamples()}
          onImport={(list) => void importExamples(list)}
          onClose={() => setExamplesOpen(false)}
        />
      )}

      {(customers.length > 0 || cases.length > 0 || examples.length > 0 || storage.fontInfo) && (
        <StorageBanner
          description={
            storage.canPersist
              ? "顧客データと受付一覧はこのブラウザ内に保存され、再読み込みしても残ります (サーバーには送信されません)。顧客データは定期点検の「保存データを消去」では消えません。学習した書き方は伏せ字にした本文だけを保存し、「受付一覧を消去」では消えません。"
              : "このタブでは保存を停止しています (再読み込みすると復元を試み直せます)。"
          }
          detail={`顧客データ ${summary.total.toLocaleString()}件 / 受付 ${cases.length}件 / 学習した書き方 ${examples.length}件`}
          usageBytes={storage.usageBytes}
          fontInfo={storage.fontInfo}
          disabled={importing || registering}
          actions={[
            ...(cases.length > 0
              ? [{ label: "受付一覧を消去", onClick: clearCases, danger: true }]
              : []),
            ...(customers.length > 0
              ? [{ label: "顧客データを削除", onClick: deleteCustomers, danger: true }]
              : []),
            ...(examples.length > 0
              ? [{ label: "学習した書き方を消去", onClick: () => void clearExamples(), danger: true }]
              : []),
          ]}
          onClearFont={storage.clearFont}
        />
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        顧客データの取り込み・完了報告書 (Excel・PDF) の作成はすべてブラウザ内で行われます。Gemini
        APIへ送るのは、お客様の氏名・電話番号・住所・メールアドレスを伏せ字にした受付内容だけです
        (キー未設定時は定型の要約になります)。学習した書き方 (伏せ字済み) も手本として一緒に送ります。
      </footer>
    </main>
  );
}
