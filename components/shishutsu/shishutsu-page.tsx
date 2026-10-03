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

/**
 * 1つの欄（選んだファイルと、そのファイルのパスワード）。
 * ★パスワードはファイルごと（表によってかかっていたり、違ったりする。2026-10-03）。保存しない
 */
interface Entry {
  id: number;
  pick: Pick | null;
  password: string;
}
type Entries = Record<SheetSlot, Entry[]>;

/** 複数のファイルを選べる表（期をまたぐ月など。2026-10-03） */
const MULTI_SLOTS: ReadonlySet<SheetSlot> = new Set(["after", "inspection"]);
/** 複数選べる表で、はじめから出しておく欄の数（★1つ目を選ばないと2つ目が出ない、では分かりにくかった） */
const MULTI_INITIAL = 2;

let nextEntryId = 1;
const newEntry = (pick: Pick | null = null): Entry => ({ id: nextEntryId++, pick, password: "" });
const minEntries = (slot: SheetSlot) => (MULTI_SLOTS.has(slot) ? MULTI_INITIAL : 1);
/** 欄の数を、少なくとも決まった数にそろえる */
function padEntries(slot: SheetSlot, list: Entry[]): Entry[] {
  const out = [...list];
  while (out.length < minEntries(slot)) out.push(newEntry());
  return out;
}
const initialEntries = (): Entries => ({
  noSite: padEntries("noSite", []),
  after: padEntries("after", []),
  inspection: padEntries("inspection", []),
  end: padEntries("end", []),
});

const pickKey = (pick: Pick) =>
  pick.kind === "shared" ? `shared:${pick.path.join("/")}` : `file:${pick.file.name}:${pick.file.size}:${pick.file.lastModified}`;
const pickName = (pick: Pick) => (pick.kind === "shared" ? pathText(pick.path) : `PC から選んだファイル: ${pick.file.name}`);
/** 注意の文に出す短い名前（ファイル名だけ） */
const pickShortName = (pick: Pick) => (pick.kind === "shared" ? (pick.path.at(-1) ?? "") : pick.file.name);

const SLOT_LABELS: Record<SheetSlot, string> = {
  noSite: "進捗管理表（現場対応なし）",
  after: "アフター進捗管理表",
  inspection: "年次点検進捗管理表",
  end: "エンド立会管理表",
};

/** 前回選んだ場所（このブラウザだけの便利のため。読めなくても動く。★パスワードは覚えない） */
const PICKS_KEY = "folio:shishutsu:picks";
function loadRememberedPicks(): Partial<Record<SheetSlot, string[]>> {
  try {
    const raw = window.localStorage.getItem(PICKS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<SheetSlot, string | string[]>>) : {};
    // 以前は1つずつ（文字列）で覚えていた
    return Object.fromEntries(
      Object.entries(parsed).map(([slot, v]) => [slot, Array.isArray(v) ? v : typeof v === "string" ? [v] : []]),
    ) as Partial<Record<SheetSlot, string[]>>;
  } catch {
    return {};
  }
}
function rememberPicks(entries: Entries): void {
  try {
    const out: Partial<Record<SheetSlot, string[]>> = {};
    for (const [slot, list] of Object.entries(entries) as [SheetSlot, Entry[]][]) {
      out[slot] = list.flatMap((e) => (e.pick?.kind === "shared" ? [e.pick.path.join("/")] : []));
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
  const [entries, setEntries] = useState<Entries>(initialEntries);
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
        setEntries((prev) => {
          const next = { ...prev };
          for (const slot of Object.keys(SLOT_LABELS) as SheetSlot[]) {
            // 利用者がもう選んだ欄（PC のファイル・共有フォルダーのファイル）は上書きしない
            if (prev[slot].some((e) => e.pick !== null)) continue;
            const known = (remembered[slot] ?? [])
              .map((path) => files.find((f) => f.path.join("/") === path))
              .filter((f): f is FolderXlsx => f !== undefined);
            const hits = known.length > 0 ? known : [guessFile(files, slot)].filter((f): f is FolderXlsx => f !== null);
            const used = MULTI_SLOTS.has(slot) ? hits : hits.slice(0, 1);
            // ★欄（とその中のパスワード）は作り直さず、前から順に埋める
            const filled = prev[slot].map((e, i) => (used[i] ? { ...e, pick: { kind: "shared", path: used[i].path } as Pick } : e));
            const extra = used.slice(filled.length).map((f) => newEntry({ kind: "shared", path: f.path }));
            next[slot] = padEntries(slot, [...filled, ...extra]);
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

  /** 1つの欄を変える（ファイル・パスワード） */
  const updateEntry = (slot: SheetSlot, id: number, patch: Partial<Omit<Entry, "id">>) => {
    setEntries((prev) => ({ ...prev, [slot]: prev[slot].map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
    setReport(null);
  };
  /** 欄を1つ足す（複数選べる表だけ） */
  const addEntry = (slot: SheetSlot) => {
    setEntries((prev) => ({ ...prev, [slot]: [...prev[slot], newEntry()] }));
  };
  /** 欄を1つ消す（はじめから出ている数より少なくはしない） */
  const removeEntry = (slot: SheetSlot, id: number) => {
    setEntries((prev) => ({ ...prev, [slot]: padEntries(slot, prev[slot].filter((e) => e.id !== id)) }));
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
    /** その表で、ファイルを選んである欄 */
    const chosen = (slot: SheetSlot) => entries[slot].filter((e): e is Entry & { pick: Pick } => e.pick !== null);
    for (const slot of Object.keys(SLOT_LABELS) as SheetSlot[]) {
      const keys = chosen(slot).map((e) => pickKey(e.pick));
      const twice = keys.find((k, i) => keys.indexOf(k) !== i);
      if (twice) return setError(`${SLOT_LABELS[slot]}で、同じファイルを2つの欄に選んでいます`);
    }
    if (chosen("after").length === 0) return setError("アフター進捗管理表を選んでください");
    if (chosen("end").length === 0) return setError("エンド立会管理表を選んでください");
    if (hadNoSite && chosen("noSite").length === 0) return setError("進捗管理表（現場対応なし）を選んでください（無かった月は「無かった」を選んでください）");
    if (tenmatsu.kind !== "ok") return setError("顛末書の記録を読めていません（下の「顛末書」の欄を見てください）");
    setBusy(true);
    try {
      let fileNo = 0;
      /** 選んだファイルを全部読む（行にファイルの番号を付ける）。1つも選んでいなければ null */
      /** どの表のどのファイルかを、注意の文に出す名前 */
      const labelOf = (slot: SheetSlot, entry: Entry & { pick: Pick }) => `${SLOT_LABELS[slot]}「${pickShortName(entry.pick)}」`;
      const progress = async (slot: "after" | "noSite" | "inspection", source: ProgressRow["source"]) => {
        const list = chosen(slot);
        if (list.length === 0) return null;
        const rows: ProgressRow[] = [];
        for (const entry of list) {
          const label = labelOf(slot, entry);
          const no = fileNo++;
          // ★パスワードはその欄に入れたもの（ファイルごと）
          const read = readProgressSheet(await openSheets(await readPick(entry.pick), entry.password, label), source, label);
          rows.push(...read.map((r) => ({ ...r, fileNo: no })));
        }
        return rows;
      };
      const after = (await progress("after", "after")) ?? [];
      const noSite = hadNoSite ? ((await progress("noSite", "noSite")) ?? []) : [];
      const inspection = await progress("inspection", "inspection");
      const endEntry = chosen("end")[0];
      const end = readEndSheet(await openSheets(await readPick(endEntry.pick), endEntry.password, labelOf("end", endEntry)));
      const built = buildExpenseReport({ year, month, after, noSite, inspection, end, tenmatsu: tenmatsu.entries });
      const res = await fetch(EXPENSE_TEMPLATE_PATH, { cache: "no-store" });
      if (!res.ok) throw new Error(`支出報告書のひな形を読み込めませんでした（HTTP ${res.status}）`);
      const bytes = buildExpenseXlsx(new Uint8Array(await res.arrayBuffer()), built);
      downloadBytes(bytes, expenseFileName(year, month), XLSX_MIME);
      setReport(built);
      rememberPicks(entries);
    } catch (e) {
      setError(e instanceof PasswordNeededError ? e.message : `支出報告書を作れませんでした（${errorText(e)}）`);
    } finally {
      setBusy(false);
    }
  };

  const years = [initial.year - 1, initial.year, initial.year + 1];
  const sharedReady = connection.state === "connected" && sharedFiles !== null;
  /** 欄の部品に渡す共通のもの */
  const entryProps = (slot: SheetSlot) => ({
    entries: entries[slot],
    files: sharedFiles,
    sharedReady,
    disabled: busy,
    onUpdate: (id: number, patch: Partial<Omit<Entry, "id">>) => updateEntry(slot, id, patch),
    onAdd: () => addEntry(slot),
    onRemove: (id: number) => removeEntry(slot, id),
  });

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
            <SlotEntries slot="noSite" {...entryProps("noSite")} />
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
          <p className="mt-2 text-xs text-slate-500">
            パスワードはファイルごとに、そのファイルの右の欄へ入れてください。かかっていない表は空のままで構いません（パスワードは保存しません）。
          </p>
          <SlotEntries slot="after" {...entryProps("after")} />
          <SlotEntries slot="inspection" {...entryProps("inspection")} optional />
          <SlotEntries slot="end" {...entryProps("end")} />

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

type SlotEntriesProps = {
  slot: SheetSlot;
  entries: Entry[];
  files: FolderXlsx[] | null;
  sharedReady: boolean;
  disabled: boolean;
  optional?: boolean;
  onUpdate: (id: number, patch: Partial<Omit<Entry, "id">>) => void;
  onAdd: () => void;
  onRemove: (id: number) => void;
};

const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * 1つの表の欄（ファイル＋パスワード）を並べる。
 * ★アフター進捗・年次点検は、はじめから2つの欄を出す（期をまたぐ月は2つ目に前の期の表）。足りなければ足せる
 * ★パスワードは欄ごと（ファイルによってかかっていたり、違ったりする）
 */
function SlotEntries({ slot, entries, files, sharedReady, disabled, optional, onUpdate, onAdd, onRemove }: SlotEntriesProps) {
  const multi = MULTI_SLOTS.has(slot);
  const label = SLOT_LABELS[slot];
  const hint = multi
    ? `期をまたぐ月は、2つ目の欄に前の期の表を選んでください。使わない欄は「（選ばない）」のままで構いません${
        optional ? "。1つも選ばなければ 1T・2T・３ヶ月の行は入りません" : ""
      }`
    : optional
      ? "無ければ選ばない"
      : null;
  return (
    // ★fieldset は既定で中身より縮まない（スマホ幅で長いファイル名の欄がはみ出した）ので min-w-0
    <fieldset className="mt-5 min-w-0">
      <legend className="text-sm font-medium">
        {label}
        {hint && <span className="ml-2 text-xs font-normal text-slate-500">（{hint}）</span>}
      </legend>
      <div className="mt-1 space-y-2">
        {entries.map((entry, i) => {
          // ほかの欄で選んでいる共有フォルダーのファイルは候補から外す（同じファイルを2回選ばない）
          const taken = new Set(
            entries.filter((e) => e.id !== entry.id && e.pick).map((e) => pickKey(e.pick as Pick)),
          );
          return (
            <EntryRow
              key={entry.id}
              slot={slot}
              entry={entry}
              no={multi ? i + 1 : null}
              files={(files ?? []).filter((f) => !taken.has(pickKey({ kind: "shared", path: f.path })))}
              sharedReady={sharedReady}
              disabled={disabled}
              canRemove={multi && entries.length > MULTI_INITIAL}
              onUpdate={(patch) => onUpdate(entry.id, patch)}
              onRemove={() => onRemove(entry.id)}
            />
          );
        })}
      </div>
      {multi && (
        <button
          type="button"
          className="mt-2 cursor-pointer text-sm font-semibold text-blue-700 underline hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onClick={onAdd}
        >
          ＋ もう1つ足す
        </button>
      )}
    </fieldset>
  );
}

function EntryRow(props: {
  slot: SheetSlot;
  entry: Entry;
  /** 何番目の欄か（1つしか無い表では null） */
  no: number | null;
  files: FolderXlsx[];
  sharedReady: boolean;
  disabled: boolean;
  canRemove: boolean;
  onUpdate: (patch: Partial<Omit<Entry, "id">>) => void;
  onRemove: () => void;
}) {
  const { slot, entry, no, files, sharedReady, disabled, canRemove, onUpdate, onRemove } = props;
  const { pick } = entry;
  const id = `shishutsu-${slot}-${entry.id}`;
  const name = `${SLOT_LABELS[slot]}${no === null ? "" : `（${no}つ目）`}`;
  const value = pick?.kind === "shared" ? pick.path.join("/") : pick?.kind === "file" ? "__file" : "";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50/60 p-2">
      {no !== null && <span className="w-12 shrink-0 text-xs font-medium text-slate-600">{no}つ目</span>}
      <select
        id={id}
        aria-label={name}
        className={`${INPUT_CLASS} min-w-0 max-w-full flex-1 sm:max-w-[30rem]`}
        value={value}
        disabled={disabled || (!sharedReady && pick?.kind !== "file")}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__file") return;
          const hit = files.find((f) => f.path.join("/") === v);
          onUpdate({ pick: hit ? { kind: "shared", path: hit.path } : null });
        }}
      >
        <option value="">{sharedReady ? "（選ばない）" : "（共有フォルダーにつなぐと選べます）"}</option>
        {files.map((f) => (
          <option key={f.path.join("/")} value={f.path.join("/")}>
            {pathText(f.path)}
          </option>
        ))}
        {pick?.kind === "file" && <option value="__file">{pickName(pick)}</option>}
      </select>
      <label className={`${SECONDARY_BUTTON_CLASS} cursor-pointer px-3 py-1.5 text-xs`}>
        PC から選ぶ
        <input
          type="file"
          accept={XLSX_ACCEPT}
          className="sr-only"
          disabled={disabled}
          aria-label={`${name}を PC から選ぶ`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpdate({ pick: { kind: "file", file } });
            e.target.value = "";
          }}
        />
      </label>
      <input
        type="password"
        aria-label={`${name}のパスワード`}
        placeholder="パスワード（かかっていれば）"
        className={`${INPUT_CLASS} w-52`}
        value={entry.password}
        autoComplete="new-password"
        disabled={disabled}
        onChange={(e) => onUpdate({ password: e.target.value })}
      />
      {canRemove && (
        <button
          type="button"
          className="cursor-pointer text-xs font-semibold text-slate-600 underline hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          aria-label={`${name}の欄を消す`}
          onClick={onRemove}
        >
          欄を消す
        </button>
      )}
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
