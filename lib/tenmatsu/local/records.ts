/**
 * 取得の記録（`_記録/processed*.json`）を読み書きする。
 *
 * 移植元: tenmatsu.py 245-456, 569-609（read_processed_data / write_processed_data / append_processed /
 *         set_flags / register_pending / retry_pending）
 *
 * ★記録の**正本はフォルダーの中**。ブラウザ側に持たせない（一覧を取り直すと消える＝実バグ）。
 * ★移植元（Python）が書いた記録をそのまま読み、同じ形で書き戻す（キーの順・字下げ2・日本語はそのまま）。
 *   違うのは改行だけ（移植元は Windows で CRLF、こちらは LF）。どちらも JSON として同じに読める。
 * ★知らない項目は消さずに残す（将来の項目や、移植元が足した項目を落とさない）。
 * ※JS は数字だけのキーを先頭へ並べ替える。伝票No.は「TE00001500」のように文字で始まるので影響しない。
 */
import { last4 } from "@/lib/rakuraku/parse/natsuin";
import type { FlagKey } from "@/lib/tenmatsu/client";
import { type PdfFingerprint, nameKey } from "./fingerprint";
import { type FolderStore, type Path } from "./fs";
import { type LocalKindConfig, PARTS_DIR, PENDING_DIR, RECORDS_DIR } from "./kind-config";

export type RecordValue = string | string[] | Record<string, unknown>[] | number | boolean;

export interface LogEntry {
  denpyo_no: string;
  file: string;
  at: string;
  /** 保存したPDFの大きさと SHA-256（名前を変えられても中身で探せるように。fingerprint.ts） */
  pdf_size?: number;
  pdf_sha256?: string;
  /** 名前を変えられたPDFにつなぎ直したときの、元の名前と日時 */
  relinked_from?: string;
  relinked_at?: string;
  [key: string]: unknown;
}

export interface FlagsEntry {
  updated_at?: string;
  [key: string]: unknown;
}

export interface MissingEntry {
  index: number;
  name: string;
  reason?: string;
  awaiting?: boolean;
  [key: string]: unknown;
}

export interface PendingEntry {
  at: string;
  dir: string;
  missing: MissingEntry[];
  meta: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProcessedData {
  done: string[];
  log: LogEntry[];
  flags: Record<string, FlagsEntry>;
  pending: Record<string, PendingEntry>;
  [key: string]: unknown;
}

/** 記録が壊れていて読めない。★自動で直さず、控えの場所を伝えて止める */
export class RecordsCorruptError extends Error {
  constructor(
    message: string,
    readonly path: readonly string[],
    readonly backupExists: boolean,
  ) {
    super(message);
    this.name = "RecordsCorruptError";
  }
}

/** その伝票が記録に無い */
export class RecordNotFoundError extends Error {
  constructor(readonly denpyoNo: string) {
    super(`伝票No. ${denpyoNo} は記録にありません（一覧を読み込み直してください）`);
    this.name = "RecordNotFoundError";
  }
}

export const recordsPath = (cfg: LocalKindConfig): Path => [RECORDS_DIR, cfg.processedFile];
/** 1つ前の内容。移植元と同じ名前（processed.json → processed.json.bak） */
export const backupPath = (cfg: LocalKindConfig): Path => [RECORDS_DIR, `${cfg.processedFile}.bak`];

/** 移植元の `datetime.now().isoformat(timespec="seconds")` と同じ形（この PC の時刻・時差なし） */
export function localStamp(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * Python の真偽の判定と同じ（None・空文字・0・False・空の配列・空の辞書は「値が無い」）。
 * ★取れなかった値で既存の値を消さない、の判定に使う。
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  if (typeof value === "number") return !Number.isNaN(value);
  return true;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 記録を読む。無ければ空の形。壊れていれば RecordsCorruptError（★控えに自動で切り替えない） */
export async function readRecords(store: FolderStore, cfg: LocalKindConfig): Promise<ProcessedData> {
  const path = recordsPath(cfg);
  if (!(await store.exists(path))) return { done: [], log: [], flags: {}, pending: {} };
  const text = await store.readText(path);
  // 初めて書く途中で閉じられると、空のファイルだけが残ることがある（書き込みは close で一度に置き換わるので、
  // 中身のある記録が空になることは無い）。控えも無い空のファイルは「まだ記録が無い」とみなす
  if (text.trim() === "" && !(await store.exists(backupPath(cfg)))) {
    return { done: [], log: [], flags: {}, pending: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const backupExists = await store.exists(backupPath(cfg));
    const hint = backupExists
      ? `1つ前の内容が ${backupPath(cfg).join("/")} に残っています。中身を確かめて問題なければ ${path.join("/")} に写してください。`
      : "控えはありません。";
    throw new RecordsCorruptError(
      `記録（${path.join("/")}）が壊れていて読めません（${e instanceof Error ? e.message : "形が不正"}）。${hint}`,
      path,
      backupExists,
    );
  }
  if (!isObject(parsed)) {
    throw new RecordsCorruptError(`記録（${path.join("/")}）の形が不正です`, path, await store.exists(backupPath(cfg)));
  }
  const data = parsed as Partial<ProcessedData> & Record<string, unknown>;
  // 移植元の setdefault と同じく、足りない入れ物だけ足す（あるものの順番は変えない）
  if (!Array.isArray(data.done)) data.done = [];
  if (!Array.isArray(data.log)) data.log = [];
  if (!isObject(data.flags)) data.flags = {};
  if (!isObject(data.pending)) data.pending = {};
  return data as ProcessedData;
}

/** 移植元の json.dumps(ensure_ascii=False, indent=2) と同じ書き方 */
export function formatRecords(data: ProcessedData): string {
  return JSON.stringify(data, null, 2);
}

/**
 * 記録を書き換える。①今の内容を `.bak` へ写す ②新しい内容を書く（close のときに一度に置き換わる）。
 * ★途中で失敗しても、元の記録は壊れない。控えは1世代だけ。
 */
export async function writeRecords(store: FolderStore, cfg: LocalKindConfig, data: ProcessedData): Promise<void> {
  const path = recordsPath(cfg);
  if (await store.exists(path)) await store.copyFile(path, backupPath(cfg));
  await store.writeBytes(path, formatRecords(data));
}

// ---------------------------------------------------------------------------
// 同じ記録を同時に書き換えない
// ---------------------------------------------------------------------------

const locks = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * 記録ファイルごとに1本ずつ順番に処理する（読む → 変える → 書く の間に別の書き換えを挟ませない）。
 * ★移植元はスレッドのロックで守っていた。こちらは同じ画面の中の非同期処理が重ならないようにする。
 */
export function withRecordsLock<T>(store: FolderStore, cfg: LocalKindConfig, fn: () => Promise<T>): Promise<T> {
  let byFile = locks.get(store.root);
  if (!byFile) {
    byFile = new Map();
    locks.set(store.root, byFile);
  }
  const key = cfg.processedFile;
  const previous = byFile.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  byFile.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * 読んで、変えて、**変えたときだけ**書く（ロックの中で）。
 * ★自動で行う書き換え（ファイル名のつなぎ直し・指紋の後付け）に使う。
 *   何も変えないのに書くと `.bak`（控えは1世代だけ）を無駄に上書きしてしまうため。
 */
export function modifyRecords<T>(
  store: FolderStore,
  cfg: LocalKindConfig,
  change: (data: ProcessedData) => Promise<{ changed: boolean; result: T }> | { changed: boolean; result: T },
): Promise<T> {
  return withRecordsLock(store, cfg, async () => {
    const data = await readRecords(store, cfg);
    const { changed, result } = await change(data);
    if (changed) await writeRecords(store, cfg, data);
    return result;
  });
}

/** 読んで、変えて、書く（ロックの中で） */
export function updateRecords<T>(
  store: FolderStore,
  cfg: LocalKindConfig,
  change: (data: ProcessedData) => T | Promise<T>,
): Promise<T> {
  return withRecordsLock(store, cfg, async () => {
    const data = await readRecords(store, cfg);
    const result = await change(data);
    await writeRecords(store, cfg, data);
    return result;
  });
}

/** 記録に残す項目だけを、決まった順で、値があるものだけ取り出す */
export function pickMeta(cfg: LocalKindConfig, meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of cfg.metaKeys) {
    const value = meta?.[key];
    if (hasValue(value)) out[key] = value;
  }
  return out;
}

/**
 * 保存できた伝票を記録する。★**PDFを置いたら、その直後に呼ぶ。間に何も挟まない**
 * （以前は間に一覧へ戻る処理があり、それが失敗すると「PDFはあるのに記録が無い」状態になった）。
 *
 * meta には一覧から読んだ項目と伝票画面から読んだ項目を渡す。記録に残す項目に無いキーと、
 * 値が無いものは入れない。
 */
export async function appendProcessed(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  savedName: string,
  meta: Record<string, unknown> | null,
  now: Date = new Date(),
  fingerprint?: PdfFingerprint,
): Promise<void> {
  await updateRecords(store, cfg, (data) => addLogEntry(data, cfg, denpyoNo, savedName, meta, now, fingerprint));
}

/** 読んである記録に、保存できた1件を足す（書くのは呼ぶ側。ほかの書き換えと1回にまとめるため） */
export function addLogEntry(
  data: ProcessedData,
  cfg: LocalKindConfig,
  denpyoNo: string,
  savedName: string,
  meta: Record<string, unknown> | null,
  now: Date = new Date(),
  fingerprint?: PdfFingerprint,
): void {
  if (!data.done.includes(denpyoNo)) data.done.push(denpyoNo);
  // キーの順は移植元と同じ（denpyo_no, file, at のあとに記録する項目の順）。指紋は最後に足す
  // ★指紋は metaKeys に入れない（前の記録から写さず、いま書いたバイト列からだけ作るため）
  data.log.push({
    denpyo_no: denpyoNo,
    file: savedName,
    at: localStamp(now),
    ...pickMeta(cfg, meta),
    ...(fingerprint ? { pdf_size: fingerprint.pdf_size, pdf_sha256: fingerprint.pdf_sha256 } : {}),
  });
}

/** 伝票ごとの最後の記録（同じ伝票を何度か記録していれば、最後のものが今の状態） */
export function latestEntries(data: ProcessedData): Map<string, LogEntry> {
  const latest = new Map<string, LogEntry>();
  for (const entry of data.log) if (entry && typeof entry.denpyo_no === "string" && entry.denpyo_no) latest.set(entry.denpyo_no, entry);
  return latest;
}

/** その伝票の保存名（記録に名前が無ければ、移植元と同じく 接頭辞＋下4桁） */
export function recordedFileName(cfg: LocalKindConfig, denpyoNo: string, entry: LogEntry | undefined): string {
  return typeof entry?.file === "string" && entry.file ? entry.file : `${cfg.filePrefix}${last4(denpyoNo)}.pdf`;
}

/**
 * 保存済みの記録が使っているファイル名の鍵（nameKey）。
 * ★新しく保存する名前・つなぎ直す候補から外すのに使う。利用者が名前を変えて空いた名前を、
 *   別の伝票が使ってしまうと、元の記録が別のPDFを指したまま「取得済み」に見えてしまう。
 */
export function claimedNames(data: ProcessedData, cfg: LocalKindConfig): Set<string> {
  const latest = latestEntries(data);
  const names = new Set<string>();
  for (const no of data.done) names.add(nameKey(recordedFileName(cfg, no, latest.get(no))));
  return names;
}

/**
 * 完了の印を変える。指定した印だけを変え、null / undefined は「触らない」。
 * ★保存済みの伝票にしか付けられない。戻り値はその伝票の更新後の印。
 */
export async function setFlags(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  flags: Partial<Record<string, boolean | null | undefined>>,
  now: Date = new Date(),
): Promise<FlagsEntry> {
  const unknown = Object.keys(flags).filter((k) => !cfg.flagKeys.includes(k as FlagKey));
  if (unknown.length > 0) throw new Error(`知らない印です: ${unknown.join(", ")}`);
  for (const [key, value] of Object.entries(flags)) {
    if (value !== null && value !== undefined && typeof value !== "boolean") {
      throw new Error(`${key} は true / false で指定してください`);
    }
  }
  return await updateRecords(store, cfg, (data) => {
    if (!data.done.includes(denpyoNo)) throw new RecordNotFoundError(denpyoNo);
    const current: FlagsEntry = { ...(data.flags[denpyoNo] ?? {}) };
    for (const [key, value] of Object.entries(flags)) {
      if (value === null || value === undefined) continue;
      current[key] = value;
    }
    // ★すでにある項目へ入れ直しても位置は変わらない（移植元の辞書と同じ。記録の中の並びを揃える）
    current.updated_at = localStamp(now);
    data.flags[denpyoNo] = current;
    return current;
  });
}

/**
 * 保留として記録する。★**ファイルを `_保留/` へ置いてから呼ぶこと**。
 * 先に記録すると、置くのに失敗したときに「記録はあるがファイルが無い」状態になる。
 */
export async function registerPending(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  dirName: string,
  missing: MissingEntry[],
  meta: Record<string, unknown> | null,
  now: Date = new Date(),
): Promise<void> {
  await updateRecords(store, cfg, (data) => {
    data.pending[denpyoNo] = {
      at: localStamp(now),
      dir: dirName,
      missing: [...missing],
      // 一覧・伝票画面から読んだ項目。確定するときにそのまま記録へ渡す
      meta: Object.fromEntries(Object.entries(meta ?? {}).filter(([k, v]) => cfg.metaKeys.includes(k) && hasValue(v))),
    };
  });
}

export const pendingDirPath = (dirName: string): Path => [PENDING_DIR, dirName];
export const partsDirPath = (dirName: string): Path => [PARTS_DIR, dirName];

/**
 * 保留をやめる。次回の取得でこの伝票をやり直す（記録を消してから、フォルダーも消す）。
 * ★記録を先に消す。消したあとならフォルダーが残っても一覧には出ない。
 */
export async function retryPending(store: FolderStore, cfg: LocalKindConfig, denpyoNo: string): Promise<void> {
  const info = await updateRecords(store, cfg, (data) => {
    const entry = data.pending[denpyoNo];
    if (!entry) throw new RecordNotFoundError(denpyoNo);
    delete data.pending[denpyoNo];
    return entry;
  });
  await store.remove(pendingDirPath(info.dir), { recursive: true }).catch(() => undefined);
  // 前に確定して差し替え待ちだった部品も片付ける（次の取得でゼロからやり直す）
  if (cfg.keepParts) await store.remove(partsDirPath(info.dir), { recursive: true }).catch(() => undefined);
}

/** 取得の対象から外す伝票No.（保存済み＋保留中）。★保留中も含める。確定するまで取り直さないため */
export function doneAndPending(data: ProcessedData): string[] {
  return [...new Set([...data.done, ...Object.keys(data.pending)])];
}
