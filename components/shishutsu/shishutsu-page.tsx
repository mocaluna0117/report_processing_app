"use client";

import { useEffect, useMemo, useState } from "react";
import { downloadBytes } from "@/lib/download";
import { openSharedDialog } from "@/lib/shared/dialog";
import { currentSharedStore } from "@/lib/shared/connection";
import { useSharedConnection } from "@/lib/shared/use-shared-folder";
import { type ExpenseReport, buildExpenseReport, expenseFileName } from "@/lib/shishutsu/build";
import { type FolderXlsx, type SheetSlot, guessFile, listFolderXlsx, pathText } from "@/lib/shishutsu/files";
import { PasswordNeededError, openSheets } from "@/lib/shishutsu/load";
import { type ProgressRow, readEndSheet, readProgressSheet } from "@/lib/shishutsu/sheets";
import { type TenmatsuEntry, toTenmatsuEntries } from "@/lib/shishutsu/tenmatsu";
import { EXPENSE_TEMPLATE_PATH, XLSX_MIME, buildExpenseXlsx } from "@/lib/shishutsu/xlsx";
import { type BrowserDirHandle, ensureFolderPermission, pickFolder, queryFolderPermission } from "@/lib/tenmatsu/local/folder-handle";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { readRecords } from "@/lib/tenmatsu/local/records";
import { loadFolderHandle } from "@/lib/tenmatsu/store";

const SECTION_CLASS = "rounded-lg border border-slate-200 bg-white p-4";
const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_CLASS =
  "rounded border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50";
const ERROR_CLASS = "mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800";
const WARN_CLASS = "mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900";

/** 選んだ表。共有フォルダーの中のファイルか、PC から選んだファイル */
type Pick = { kind: "shared"; path: string[] } | { kind: "file"; file: File };

const SLOT_LABELS: Record<SheetSlot, string> = {
  noSite: "進捗管理表（現場対応なし）",
  after: "アフター進捗管理表",
  inspection: "年次点検進捗管理表",
  end: "エンド立会管理表",
};

/** 前回選んだ場所（このブラウザだけの便利のため。読めなくても動く） */
const PICKS_KEY = "folio:shishutsu:picks";
function loadRememberedPicks(): Partial<Record<SheetSlot, string>> {
  try {
    const raw = window.localStorage.getItem(PICKS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<SheetSlot, string>>) : {};
  } catch {
    return {};
  }
}
function rememberPicks(picks: Partial<Record<SheetSlot, Pick | null>>): void {
  try {
    const out: Partial<Record<SheetSlot, string>> = {};
    for (const [slot, pick] of Object.entries(picks) as [SheetSlot, Pick | null][]) {
      if (pick?.kind === "shared") out[slot] = pick.path.join("/");
    }
    window.localStorage.setItem(PICKS_KEY, JSON.stringify(out));
  } catch {
    // 覚えられなくても作れる
  }
}

type TenmatsuState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "prompt"; handle: BrowserDirHandle }
  | { kind: "ok"; entries: TenmatsuEntry[]; folder: string }
  | { kind: "error"; message: string };

type Step = "start" | "noSite" | "sheets";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function previousMonth(): { year: number; month: number } {
  const now = new Date();
  const m = now.getMonth(); // 0始まり＝先月の月番号
  return m === 0 ? { year: now.getFullYear() - 1, month: 12 } : { year: now.getFullYear(), month: m };
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")} 円`;

export function ShishutsuPage() {
  const initial = useMemo(previousMonth, []);
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [step, setStep] = useState<Step>("start");
  const [hadNoSite, setHadNoSite] = useState<boolean | null>(null);
  const [picks, setPicks] = useState<Record<SheetSlot, Pick | null>>({ noSite: null, after: null, inspection: null, end: null });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ExpenseReport | null>(null);

  // --- 共有フォルダーの中の xlsx
  const connection = useSharedConnection();
  const [sharedFiles, setSharedFiles] = useState<FolderXlsx[] | null>(null);
  const [sharedError, setSharedError] = useState<string | null>(null);
  useEffect(() => {
    if (connection.state !== "connected") return;
    const store = currentSharedStore();
    if (!store) return;
    let alive = true;
    void listFolderXlsx(store)
      .then((files) => {
        if (!alive) return;
        setSharedFiles(files);
        setSharedError(null);
        // 前回選んだもの → 名前の見当、の順で選んでおく（PC から選んだものは上書きしない）
        const remembered = loadRememberedPicks();
        setPicks((prev) => {
          const next = { ...prev };
          for (const slot of Object.keys(SLOT_LABELS) as SheetSlot[]) {
            if (next[slot]?.kind === "file") continue;
            const hit = files.find((f) => f.path.join("/") === remembered[slot]) ?? guessFile(files, slot);
            next[slot] = hit ? { kind: "shared", path: hit.path } : null;
          }
          return next;
        });
      })
      .catch((e) => alive && setSharedError(`共有フォルダーの中を読めませんでした（${errorText(e)}）`));
    return () => {
      alive = false;
    };
  }, [connection.state, connection.folderName]);

  // --- 顛末書の記録（顛末書の画面で選んだ保存先フォルダー）
  const [tenmatsu, setTenmatsu] = useState<TenmatsuState>({ kind: "loading" });
  const readTenmatsu = async (handle: BrowserDirHandle) => {
    const records = await readRecords(new FolderStore(handle), LOCAL_KINDS.tenmatsu);
    setTenmatsu({ kind: "ok", entries: toTenmatsuEntries(records), folder: handle.name });
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const handle = await loadFolderHandle<BrowserDirHandle>("tenmatsu");
        if (!alive) return;
        if (!handle) return setTenmatsu({ kind: "none" });
        if ((await queryFolderPermission(handle)) !== "granted") return alive && setTenmatsu({ kind: "prompt", handle });
        if (alive) await readTenmatsu(handle);
      } catch (e) {
        if (alive) setTenmatsu({ kind: "error", message: `顛末書の記録を読めませんでした（${errorText(e)}）` });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  /** 顛末書の画面でまだ保存先を選んでいないとき、ここで選ぶ（★この画面では覚えない。覚えるのは顛末書の画面） */
  const pickTenmatsu = async () => {
    try {
      const handle = await pickFolder("tenmatsu");
      if (handle) await readTenmatsu(handle);
    } catch (e) {
      setTenmatsu({ kind: "error", message: `顛末書の保存先を開けませんでした（${errorText(e)}）` });
    }
  };
  const connectTenmatsu = async (handle: BrowserDirHandle) => {
    try {
      await ensureFolderPermission(handle);
      await readTenmatsu(handle);
    } catch (e) {
      setTenmatsu({ kind: "error", message: `顛末書の保存先を開けませんでした（${errorText(e)}）` });
    }
  };

  const choose = (slot: SheetSlot, pick: Pick | null) => {
    setPicks((prev) => ({ ...prev, [slot]: pick }));
    setReport(null);
  };

  const readPick = async (pick: Pick): Promise<Uint8Array> => {
    if (pick.kind === "file") return new Uint8Array(await pick.file.arrayBuffer());
    const store = currentSharedStore();
    if (!store) throw new Error("共有フォルダーにつながっていません");
    return await store.readBytes(pick.path);
  };

  const create = async () => {
    setError(null);
    setReport(null);
    if (!picks.after) return setError("アフター進捗管理表を選んでください");
    if (!picks.end) return setError("エンド立会管理表を選んでください");
    if (hadNoSite && !picks.noSite) return setError("進捗管理表（現場対応なし）を選んでください（無かった月は「無かった」を選んでください）");
    if (tenmatsu.kind !== "ok") return setError("顛末書の記録を読めていません（下の「顛末書」の欄を見てください）");
    setBusy(true);
    try {
      const progress = async (slot: "after" | "noSite" | "inspection", source: ProgressRow["source"]) => {
        const pick = picks[slot];
        if (!pick) return null;
        return readProgressSheet(await openSheets(await readPick(pick), password, SLOT_LABELS[slot]), source, SLOT_LABELS[slot]);
      };
      const after = (await progress("after", "after")) ?? [];
      const noSite = hadNoSite ? ((await progress("noSite", "noSite")) ?? []) : [];
      const inspection = await progress("inspection", "inspection");
      const end = readEndSheet(await openSheets(await readPick(picks.end), password, SLOT_LABELS.end));
      const built = buildExpenseReport({ year, month, after, noSite, inspection, end, tenmatsu: tenmatsu.entries });
      const res = await fetch(EXPENSE_TEMPLATE_PATH, { cache: "no-store" });
      if (!res.ok) throw new Error(`支出報告書のひな形を読み込めませんでした（HTTP ${res.status}）`);
      const bytes = buildExpenseXlsx(new Uint8Array(await res.arrayBuffer()), built);
      downloadBytes(bytes, expenseFileName(year, month), XLSX_MIME);
      setReport(built);
      rememberPicks(picks);
    } catch (e) {
      setError(e instanceof PasswordNeededError ? e.message : `支出報告書を作れませんでした（${errorText(e)}）`);
    } finally {
      setBusy(false);
    }
  };

  const years = [initial.year - 1, initial.year, initial.year + 1];
  const sharedReady = connection.state === "connected" && sharedFiles !== null;

  return (
    <main className="mt-6 space-y-4">
      <section className={SECTION_CLASS}>
        <h2 className="text-lg font-semibold">支出報告書</h2>
        <p className="mt-1 text-sm text-slate-600">
          進捗管理表の完了日と顛末書の支払金額（税抜）から、月ごとの支出報告書（Excel）を作ります。
          表も顛末書の記録も、このブラウザの中で読むだけで、Folio のサーバーには送りません。
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">年</span>
            <select className={INPUT_CLASS} value={year} onChange={(e) => (setYear(Number(e.target.value)), setReport(null))} disabled={busy}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">月</span>
            <select className={INPUT_CLASS} value={month} onChange={(e) => (setMonth(Number(e.target.value)), setReport(null))} disabled={busy}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}月度
                </option>
              ))}
            </select>
          </label>
          {step === "start" && (
            <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={() => setStep("noSite")}>
              支出報告書を作成
            </button>
          )}
        </div>
      </section>

      {step !== "start" && (
        <section className={SECTION_CLASS} aria-labelledby="shishutsu-nosite">
          <h3 id="shishutsu-nosite" className="font-semibold">
            1. 現場対応なしの対応
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            電話や説明だけで済んだ対応（現場対応なし）が {month}月にありましたか。あれば「{SLOT_LABELS.noSite}」を選びます。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={hadNoSite === true}
              className={hadNoSite === true ? PRIMARY_BUTTON_CLASS : SECONDARY_BUTTON_CLASS}
              onClick={() => (setHadNoSite(true), setStep("sheets"), setReport(null))}
            >
              あった
            </button>
            <button
              type="button"
              aria-pressed={hadNoSite === false}
              className={hadNoSite === false ? PRIMARY_BUTTON_CLASS : SECONDARY_BUTTON_CLASS}
              onClick={() => (setHadNoSite(false), setStep("sheets"), setReport(null))}
            >
              無かった
            </button>
          </div>
          {hadNoSite && (
            <SlotPicker slot="noSite" pick={picks.noSite} files={sharedFiles} sharedReady={sharedReady} onChange={choose} disabled={busy} />
          )}
        </section>
      )}

      {step === "sheets" && (
        <section className={SECTION_CLASS} aria-labelledby="shishutsu-sheets">
          <h3 id="shishutsu-sheets" className="font-semibold">
            2. Box の進捗管理表を選ぶ
          </h3>
          {connection.state !== "connected" ? (
            <p className={WARN_CLASS}>
              共有フォルダー（Box）につながっていません。
              <button type="button" className="ml-1 cursor-pointer font-semibold underline" onClick={openSharedDialog}>
                共有フォルダーにつなぐ
              </button>
              と、中の進捗管理表から選べます。PC のファイルを選ぶこともできます。
            </p>
          ) : sharedFiles === null && !sharedError ? (
            <p className="mt-2 text-sm text-slate-500">共有フォルダー「{connection.folderName}」の中を探しています…</p>
          ) : (
            <p className="mt-1 text-sm text-slate-600">
              共有フォルダー「{connection.folderName}」の中から、名前で見当を付けて選んであります。違っていれば選び直してください。
            </p>
          )}
          {sharedError && <p className={ERROR_CLASS}>{sharedError}</p>}
          <SlotPicker slot="after" pick={picks.after} files={sharedFiles} sharedReady={sharedReady} onChange={choose} disabled={busy} />
          <SlotPicker slot="inspection" pick={picks.inspection} files={sharedFiles} sharedReady={sharedReady} onChange={choose} disabled={busy} optional />
          <SlotPicker slot="end" pick={picks.end} files={sharedFiles} sharedReady={sharedReady} onChange={choose} disabled={busy} />
          <label className="mt-4 block text-sm">
            <span className="mb-1 block font-medium">パスワード付きの表のパスワード</span>
            <input
              type="password"
              className={`${INPUT_CLASS} w-64`}
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <span className="mt-1 block text-xs text-slate-500">年次点検進捗管理表のように、開くときにパスワードを聞かれる表だけに使います。保存しません。</span>
          </label>

          <TenmatsuLine state={tenmatsu} onConnect={connectTenmatsu} onPick={pickTenmatsu} />

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={() => void create()} disabled={busy} aria-busy={busy}>
              {busy ? "作っています…" : `${year}年${month}月度の支出報告書を作る`}
            </button>
            <span className="text-xs text-slate-500">できた Excel はそのままダウンロードされます。</span>
          </div>
          {error && <p className={ERROR_CLASS}>{error}</p>}
        </section>
      )}

      {report && <ReportSummary report={report} />}
    </main>
  );
}

function SlotPicker(props: {
  slot: SheetSlot;
  pick: Pick | null;
  files: FolderXlsx[] | null;
  sharedReady: boolean;
  onChange: (slot: SheetSlot, pick: Pick | null) => void;
  disabled: boolean;
  optional?: boolean;
}) {
  const { slot, pick, files, sharedReady, onChange, disabled, optional } = props;
  const id = `shishutsu-${slot}`;
  const value = pick?.kind === "shared" ? pick.path.join("/") : pick?.kind === "file" ? "__file" : "";
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-sm font-medium">
        {SLOT_LABELS[slot]}
        {optional && <span className="ml-2 text-xs font-normal text-slate-500">（無ければ選ばない。1T・2T・３ヶ月の行が入りません）</span>}
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select
          id={id}
          className={`${INPUT_CLASS} max-w-full sm:w-[34rem]`}
          value={value}
          disabled={disabled || (!sharedReady && pick?.kind !== "file")}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__file") return;
            const hit = files?.find((f) => f.path.join("/") === v);
            onChange(slot, hit ? { kind: "shared", path: hit.path } : null);
          }}
        >
          <option value="">（選ばない）</option>
          {files?.map((f) => (
            <option key={f.path.join("/")} value={f.path.join("/")}>
              {pathText(f.path)}
            </option>
          ))}
          {pick?.kind === "file" && <option value="__file">PC から選んだファイル: {pick.file.name}</option>}
        </select>
        <label className={`${SECONDARY_BUTTON_CLASS} cursor-pointer px-3 py-1.5 text-xs`}>
          PC から選ぶ
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onChange(slot, { kind: "file", file });
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

function TenmatsuLine({
  state,
  onConnect,
  onPick,
}: {
  state: TenmatsuState;
  onConnect: (handle: BrowserDirHandle) => void;
  onPick: () => void;
}) {
  const box = "mt-5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm";
  if (state.kind === "loading") return <p className={box}>顛末書の記録を読んでいます…</p>;
  if (state.kind === "none") {
    return (
      <p className={WARN_CLASS}>
        顛末書の保存先フォルダーがまだ選ばれていません（ふだんは「顛末書」の画面で選びます）。
        <button type="button" className="ml-1 cursor-pointer font-semibold underline" onClick={onPick}>
          顛末書の保存先を選ぶ
        </button>
      </p>
    );
  }
  if (state.kind === "prompt") {
    return (
      <p className={WARN_CLASS}>
        顛末書の保存先「{state.handle.name}」を読む許可が要ります。
        <button type="button" className="ml-1 cursor-pointer font-semibold underline" onClick={() => onConnect(state.handle)}>
          保存先につなぐ
        </button>
      </p>
    );
  }
  if (state.kind === "error") return <p className={ERROR_CLASS}>{state.message}</p>;
  const missing = state.entries.filter((e) => e.amountExTax === null).length;
  return (
    <p className={box}>
      顛末書: 保存先「{state.folder}」の記録 {state.entries.length}件
      {missing > 0 && (
        <span className="ml-1 text-amber-800">
          （うち {missing}件は支払金額(税抜)が記録に無く、税込÷1.1 で概算します。「顛末書」の画面の「税抜を読み直す」で正確になります）
        </span>
      )}
    </p>
  );
}

function ReportSummary({ report }: { report: ExpenseReport }) {
  return (
    <section className={SECTION_CLASS} aria-labelledby="shishutsu-result">
      <h3 id="shishutsu-result" className="font-semibold">
        作成しました: {expenseFileName(report.year, report.month)}
      </h3>
      <table className="mt-3 text-sm">
        <tbody>
          {report.sections.map((s) => (
            <tr key={s.key}>
              <th className="pr-4 text-left font-medium">{s.label}</th>
              <td className="pr-4 tabular-nums">{s.cases}件</td>
              <td className="tabular-nums text-slate-600">{s.rows.length}行</td>
            </tr>
          ))}
          <tr>
            <th className="pr-4 pt-1 text-left font-medium">原価の合計</th>
            <td className="pt-1 tabular-nums" colSpan={2}>
              {yen(report.totalCost)}
            </td>
          </tr>
        </tbody>
      </table>
      {report.warnings.length > 0 && (
        <div className={WARN_CLASS}>
          <p className="font-medium">確かめてほしいこと</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        受注（その他・保険・相殺）は 0 で出しています。保険の還付金や有償工事の受注は Excel で入れてください。
      </p>
    </section>
  );
}
