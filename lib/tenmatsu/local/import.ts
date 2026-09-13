/**
 * 今までの方式（PCの顛末書取得ツール）の記録を、新しい方式のフォルダーへ取り込む。
 *
 * 旧ツールの記録は `~/tenmatsu-dl/processed.json`（専決決裁書は processed_senketsu.json、
 * 捺印決裁書は processed_natsuin.json）にある。PDF・_保留・_部品 は旧ツールの保存先フォルダー
 * （Documents\顛末書 など）にあるので、新しい方式でそのフォルダーを選んでから記録を入れれば、
 * 今までの一覧・完了の印・アップロード待ちがそのまま続きから使える。
 *
 * 合わせ方（何度取り込んでも同じ結果になる）:
 *   - done … 和集合。★取り込む記録（古い）を前に、フォルダーにあった記録（新しい）を後ろに並べる
 *            （一覧は「記録に足した順の逆」なので、新しい方式で取った分が上に来る）
 *   - log  … 同じ (伝票No., 取得日時, ファイル名) は1つにまとめる
 *   - flags … 伝票ごとに updated_at の新しい方を採る（同じなら今フォルダーにある方）
 *   - pending … `_保留/<dir>/manifest.json` がフォルダーに**実在するもの**だけ。保存済みの伝票の保留は入れない
 *   - それ以外の項目 … フォルダーにある方を残し、無ければ取り込む
 * ★記録は書く前に .bak を残す（records.ts の writeRecords）。取り込み前の状態に戻せる。
 */
import type { FolderStore } from "./fs";
import { type LocalKindConfig, MANIFEST_NAME } from "./kind-config";
import { last4 } from "./naming";
import {
  type FlagsEntry,
  type LogEntry,
  type PendingEntry,
  type ProcessedData,
  pendingDirPath,
  readRecords,
  updateRecords,
} from "./records";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 旧ツールの記録を読む。形が違えば ImportError（★読めた分だけ取り込むことはしない） */
export function parseProcessedJson(text: string): ProcessedData {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ImportError("記録のファイルとして読めませんでした（JSON の形ではありません）。processed.json を選んでください");
  }
  if (!isObject(raw) || !Array.isArray(raw.done) || !Array.isArray(raw.log)) {
    throw new ImportError("取得の記録の形ではありません（done と log が見つかりません）。processed.json を選んでください");
  }
  const done = raw.done.filter((no): no is string => typeof no === "string" && no !== "");
  if (done.length !== raw.done.length) throw new ImportError("記録の done に伝票No.でない値が入っています");
  const log = raw.log.filter((e): e is LogEntry => isObject(e) && typeof e.denpyo_no === "string" && typeof e.file === "string");
  if (log.length !== raw.log.length) throw new ImportError("記録の log に形の違う行が入っています");
  const flags = isObject(raw.flags) ? (raw.flags as Record<string, FlagsEntry>) : {};
  const pending = isObject(raw.pending) ? (raw.pending as Record<string, PendingEntry>) : {};
  for (const [no, entry] of Object.entries(pending)) {
    if (!isObject(entry) || typeof entry.dir !== "string" || !Array.isArray(entry.missing)) {
      throw new ImportError(`記録の保留（伝票No. ${no}）の形が違います`);
    }
  }
  return { ...raw, done, log, flags, pending };
}

export interface ImportSummary {
  /** 取り込むファイルに入っていた保存済みの伝票の数 */
  incoming: number;
  /** 新しく一覧に加わる伝票の数 */
  added: number;
  /** すでにフォルダーの記録にあった伝票の数 */
  already: number;
  /** 取り込む側が採られた完了の印の数 */
  flagsTaken: number;
  /** 取り込んだ保留の数 */
  pendingTaken: number;
  /** フォルダーにファイルが無いので取り込まなかった保留（伝票No.） */
  pendingWithoutFiles: string[];
  /** 保存済みなので取り込まなかった・外した保留（伝票No.） */
  pendingAlreadySaved: string[];
  /** 取り込んだあとの保存済みの伝票のうち、PDF がフォルダーに見つかった数 */
  pdfFound: number;
  /** PDF がフォルダーに見つからなかったファイル名（先頭の数件） */
  pdfMissing: string[];
  pdfMissingCount: number;
}

const logKey = (e: LogEntry) => [e.denpyo_no, String(e.at ?? ""), e.file].join("\u0000");

/** 記録を合わせる（純粋な規則。保留のフォルダーの有無は pendingExists で受け取る） */
export function mergeRecords(
  current: ProcessedData,
  incoming: ProcessedData,
  pendingExists: (dir: string) => boolean,
): { merged: ProcessedData; summary: Omit<ImportSummary, "pdfFound" | "pdfMissing" | "pdfMissingCount"> } {
  const currentDone = new Set(current.done);
  const done = [...new Set([...incoming.done, ...current.done])];
  const doneSet = new Set(done);

  const seen = new Set<string>();
  const log: LogEntry[] = [];
  for (const entry of [...incoming.log, ...current.log]) {
    const key = logKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    log.push(entry);
  }

  const flags: Record<string, FlagsEntry> = { ...current.flags };
  let flagsTaken = 0;
  for (const [no, entry] of Object.entries(incoming.flags)) {
    const mine = flags[no];
    if (!mine || String(entry?.updated_at ?? "") > String(mine.updated_at ?? "")) {
      flags[no] = entry;
      flagsTaken += 1;
    }
  }

  const pending: Record<string, PendingEntry> = {};
  const pendingAlreadySaved: string[] = [];
  const pendingWithoutFiles: string[] = [];
  let pendingTaken = 0;
  for (const [no, entry] of Object.entries(current.pending)) {
    // ★旧ツールで保存済みになっていた伝票の保留は外す（同じ伝票が「保存済み」と「保留」の両方に出ないように）
    if (doneSet.has(no) && !currentDone.has(no)) pendingAlreadySaved.push(no);
    else pending[no] = entry;
  }
  for (const [no, entry] of Object.entries(incoming.pending)) {
    if (pending[no]) continue; // フォルダーにある方を残す
    if (doneSet.has(no)) {
      pendingAlreadySaved.push(no);
      continue;
    }
    if (!pendingExists(entry.dir || no)) {
      pendingWithoutFiles.push(no);
      continue;
    }
    pending[no] = entry;
    pendingTaken += 1;
  }

  // それ以外の項目: フォルダーにある方を残し、無ければ取り込む
  const extra: Record<string, unknown> = {};
  const known = new Set(["done", "log", "flags", "pending"]);
  for (const [key, value] of Object.entries(incoming)) if (!known.has(key)) extra[key] = value;
  for (const [key, value] of Object.entries(current)) if (!known.has(key)) extra[key] = value;

  return {
    merged: { done, log, flags, pending, ...extra },
    summary: {
      incoming: incoming.done.length,
      added: done.length - current.done.length,
      already: incoming.done.filter((no) => currentDone.has(no)).length,
      flagsTaken,
      pendingTaken,
      pendingWithoutFiles,
      pendingAlreadySaved,
    },
  };
}

/** 合わせたあとの保存済みの伝票のうち、PDF がフォルダーにあるかを数える（選んだフォルダーが合っているかの手がかり） */
async function countPdfs(store: FolderStore, cfg: LocalKindConfig, data: ProcessedData) {
  const latest = new Map<string, LogEntry>();
  for (const entry of data.log) latest.set(entry.denpyo_no, entry);
  let pdfFound = 0;
  const missing: string[] = [];
  for (const no of data.done) {
    const file = latest.get(no)?.file || `${cfg.filePrefix}${last4(no)}.pdf`;
    if (await store.exists([file])) pdfFound += 1;
    else missing.push(file);
  }
  return { pdfFound, pdfMissing: missing.slice(0, 5), pdfMissingCount: missing.length };
}

async function pendingDirs(store: FolderStore, incoming: ProcessedData): Promise<Set<string>> {
  const found = new Set<string>();
  for (const [no, entry] of Object.entries(incoming.pending)) {
    const dir = entry.dir || no;
    if (await store.exists([...pendingDirPath(dir), MANIFEST_NAME])) found.add(dir);
  }
  return found;
}

/** 取り込むとどうなるかを、書かずに調べる（確認の画面に出す） */
export async function previewImport(store: FolderStore, cfg: LocalKindConfig, text: string): Promise<ImportSummary> {
  const incoming = parseProcessedJson(text);
  const dirs = await pendingDirs(store, incoming);
  const { merged, summary } = mergeRecords(await readRecords(store, cfg), incoming, (dir) => dirs.has(dir));
  return { ...summary, ...(await countPdfs(store, cfg, merged)) };
}

/** 取り込む。★書く前に .bak を残す。書いている間は、ほかの記録の書き換えと重ならない */
export async function importRecords(store: FolderStore, cfg: LocalKindConfig, text: string): Promise<ImportSummary> {
  const incoming = parseProcessedJson(text);
  const dirs = await pendingDirs(store, incoming);
  let result: ReturnType<typeof mergeRecords> | null = null;
  await updateRecords(store, cfg, (data) => {
    const merged = mergeRecords(data, incoming, (dir) => dirs.has(dir));
    for (const key of Object.keys(data)) delete (data as Record<string, unknown>)[key];
    Object.assign(data, merged.merged);
    result = merged;
  });
  const { merged, summary } = result as unknown as ReturnType<typeof mergeRecords>;
  return { ...summary, ...(await countPdfs(store, cfg, merged)) };
}

/**
 * 選んだファイルの名前が、この種類の記録の名前と違うときの注意。null なら注意なし。
 * ★止めはしない（名前を変えて置いている人もいる）が、取り違えると別の種類の伝票が一覧に混ざる。
 */
export function importNameWarning(cfg: LocalKindConfig, fileName: string): string | null {
  const names = ["processed.json", "processed_senketsu.json", "processed_natsuin.json"];
  const base = fileName.replace(/^.*[\\/]/, "");
  if (base === cfg.processedFile || !names.includes(base)) return null;
  return `選んだファイル（${base}）は${cfg.label}の記録（${cfg.processedFile}）ではない可能性があります。別の書類の伝票が一覧に混ざらないか確かめてください`;
}
