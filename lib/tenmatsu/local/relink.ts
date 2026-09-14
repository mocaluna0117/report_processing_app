/**
 * 名前を変えられた保存済みPDFを、中身（指紋）で探して記録に結び直す。
 *
 * ★記録とPDFはファイル名で結んでいる。利用者がPCで名前を変えると、一覧は「ファイルなし」になり、
 *   差し替えは元の名前で別のファイルを作ってしまっていた。保存したときの指紋（fingerprint.ts）で
 *   同じ中身のPDFを探し、**記録の名前を今の名前に書き換える**。以後は今の名前で動く。
 * ★推測はしない。候補が2つ以上ある・同じ中身の記録が2つある、のときは結ばない（手で選んでもらう）。
 * ★探すのは保存先の**直下だけ**（`_記録` `_保留` `_部品` などのフォルダーの中は見ない）。
 * ★自動で書くのは「変わったときだけ」（modifyRecords）。何も変えずに書くと控え（.bak）を無駄に上書きする。
 */
import type { ListItem } from "@/lib/tenmatsu/client";
import { type HashMemo, type PdfFingerprint, nameKey, readFingerprint } from "./fingerprint";
import type { FolderStore } from "./fs";
import { LOCAL_KINDS, type LocalKindConfig } from "./kind-config";
import {
  type LogEntry,
  type ProcessedData,
  claimedNames,
  latestEntries,
  localStamp,
  modifyRecords,
  readRecords,
  recordedFileName,
} from "./records";

export type RelinkErrorKind =
  /** 選んだ名前が正しくない（PDFではない・フォルダーの中を指している） */
  | "invalid"
  /** 選んだPDFが保存先の直下に無い */
  | "notFound"
  /** 保存済みの記録ではない（保留中・記録が無い） */
  | "notSaved"
  /** 記録の名前のPDFはちゃんとある（選び直す必要が無い） */
  | "notMissing"
  /** 選んだPDFは、ほかの記録が使っている */
  | "claimed"
  /** 選んでいる間に、記録かPDFが変わった */
  | "changed";

export class RelinkError extends Error {
  constructor(
    readonly kind: RelinkErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RelinkError";
  }
}

interface RootPdf {
  name: string;
  size: number;
  lastModified: number;
}

/** 保存先の直下のPDF（隠しファイル・PDF以外は除く） */
async function rootPdfs(store: FolderStore): Promise<RootPdf[]> {
  return (await store.listFiles([])).filter((f) => /\.pdf$/i.test(f.name) && !f.name.startsWith("."));
}

/**
 * ほかの種類の記録が使っている名前。★同じフォルダーを複数の種類で使っていても、
 * 別の種類のPDFを取り違えて結ばないため。読めない記録は飛ばす（その種類の画面で直してもらう）。
 */
export async function otherKindClaims(store: FolderStore, cfg: LocalKindConfig): Promise<Set<string>> {
  const names = new Set<string>();
  for (const other of Object.values(LOCAL_KINDS)) {
    if (other.id === cfg.id) continue;
    try {
      for (const name of claimedNames(await readRecords(store, other), other)) names.add(name);
    } catch {
      // 壊れた記録はここでは扱わない
    }
  }
  return names;
}

/** 記録の名前を、つなぎ直した名前に書き換える（元の名前と日時も残す） */
function linkEntry(entry: LogEntry, cfg: LocalKindConfig, name: string, fingerprint: PdfFingerprint, now: Date): void {
  const previous = recordedFileName(cfg, entry.denpyo_no, entry);
  if (previous !== name) {
    entry.relinked_from = previous;
    entry.relinked_at = localStamp(now);
  }
  entry.file = name;
  entry.pdf_size = fingerprint.pdf_size;
  entry.pdf_sha256 = fingerprint.pdf_sha256;
}

// ---------------------------------------------------------------------------
// 1. 一覧を読むときに自動で結び直す
// ---------------------------------------------------------------------------

export interface Relink {
  denpyoNo: string;
  from: string;
  to: string;
  size: number;
  lastModified: number;
  sha256: string;
}

/**
 * 名前で見つからなかった保存済みの伝票（missingNos）を、中身で探す。記録は書かない。
 * 返すのは「ちょうど1つに決まった」分だけ。決まらなかった伝票は ambiguous に入れる。
 */
export async function planRelinks(
  store: FolderStore,
  cfg: LocalKindConfig,
  records: ProcessedData,
  missingNos: readonly string[],
  deps: { memo: HashMemo; otherClaims: ReadonlySet<string> },
): Promise<{ relinks: Relink[]; ambiguous: string[] }> {
  const latest = latestEntries(records);
  const wanted: { no: string; from: string; fp: PdfFingerprint }[] = [];
  for (const no of missingNos) {
    if (!records.done.includes(no) || records.pending[no]) continue;
    const entry = latest.get(no);
    const fp = readFingerprint(entry);
    if (fp) wanted.push({ no, from: recordedFileName(cfg, no, entry), fp });
  }
  if (wanted.length === 0) return { relinks: [], ambiguous: [] };

  const claimed = claimedNames(records, cfg);
  const sizes = new Set(wanted.map((w) => w.fp.pdf_size));
  const candidates = (await rootPdfs(store)).filter(
    (f) => sizes.has(f.size) && !claimed.has(nameKey(f.name)) && !deps.otherClaims.has(nameKey(f.name)),
  );

  const bySha = new Map<string, RootPdf[]>();
  for (const file of candidates) {
    let sha: string;
    try {
      sha = await deps.memo.hash(store, file);
    } catch {
      continue; // 読めないファイルは候補にしない
    }
    const list = bySha.get(sha);
    if (list) list.push(file);
    else bySha.set(sha, [file]);
  }
  const wantedPerSha = new Map<string, number>();
  for (const w of wanted) wantedPerSha.set(w.fp.pdf_sha256, (wantedPerSha.get(w.fp.pdf_sha256) ?? 0) + 1);

  const relinks: Relink[] = [];
  const ambiguous: string[] = [];
  for (const w of wanted) {
    const found = bySha.get(w.fp.pdf_sha256) ?? [];
    if (found.length === 1 && wantedPerSha.get(w.fp.pdf_sha256) === 1) {
      const file = found[0];
      relinks.push({ denpyoNo: w.no, from: w.from, to: file.name, size: file.size, lastModified: file.lastModified, sha256: w.fp.pdf_sha256 });
    } else if (found.length > 0) {
      ambiguous.push(w.no);
    }
  }
  return { relinks, ambiguous };
}

/**
 * 決まった結び直しを記録に書く（1回の書き換え）。★ロックの中で、読み直した記録とPDFで確かめ直し、
 * 変わっていたらその分は書かない（その間に取得・差し替え・名前の戻しがあってもよいように）。
 */
export async function applyRelinks(
  store: FolderStore,
  cfg: LocalKindConfig,
  relinks: readonly Relink[],
  now: Date,
): Promise<Relink[]> {
  if (relinks.length === 0) return [];
  return await modifyRecords(store, cfg, async (data) => {
    const applied: Relink[] = [];
    const latest = latestEntries(data);
    const claimed = claimedNames(data, cfg);
    for (const r of relinks) {
      if (!data.done.includes(r.denpyoNo) || data.pending[r.denpyoNo]) continue;
      const entry = latest.get(r.denpyoNo);
      if (!entry || recordedFileName(cfg, r.denpyoNo, entry) !== r.from) continue;
      if (readFingerprint(entry)?.pdf_sha256 !== r.sha256) continue;
      if (claimed.has(nameKey(r.to))) continue;
      if ((await store.stat([r.from])) !== null) continue; // 名前が戻された
      const now2 = await store.stat([r.to]);
      if (now2?.kind !== "file" || now2.size !== r.size || now2.lastModified !== r.lastModified) continue;
      linkEntry(entry, cfg, r.to, { pdf_size: r.size, pdf_sha256: r.sha256 }, now);
      claimed.delete(nameKey(r.from));
      claimed.add(nameKey(r.to));
      applied.push(r);
    }
    return { changed: applied.length > 0, result: applied };
  });
}

// ---------------------------------------------------------------------------
// 2. 以前の記録に指紋を後から付ける
// ---------------------------------------------------------------------------

export interface BackfillTarget {
  denpyoNo: string;
  file: string;
}

/**
 * 指紋を付ける記録を選ぶ（書かない）。一覧に「取得済み」で出ていて、記録の名前どおりにPDFがあり、
 * 指紋が無い（または大きさが変わった＝同じ名前のまま中身を直した）もの。一覧の並び（新しい順）のまま。
 */
export function planBackfill(records: ProcessedData, cfg: LocalKindConfig, items: readonly ListItem[]): BackfillTarget[] {
  const latest = latestEntries(records);
  const targets: BackfillTarget[] = [];
  for (const item of items) {
    if (item.pending || !item.exists) continue;
    const entry = latest.get(item.denpyo_no);
    if (!entry || recordedFileName(cfg, item.denpyo_no, entry) !== item.file) continue;
    const fp = readFingerprint(entry);
    if (fp && (item.size === null || item.size === undefined || fp.pdf_size === item.size)) continue;
    targets.push({ denpyoNo: item.denpyo_no, file: item.file });
  }
  return targets;
}

/**
 * 指紋を付ける。ハッシュはロックの外で1件ずつ取り、書くのは1回だけ。
 * maxFiles / maxBytes で1回に読む量を抑える（最低1件は読む）。残りは次の一覧のときに。
 */
export async function runBackfill(
  store: FolderStore,
  cfg: LocalKindConfig,
  targets: readonly BackfillTarget[],
  memo: HashMemo,
  options: { maxFiles?: number; maxBytes?: number; shouldStop?: () => boolean } = {},
): Promise<{ written: number; processed: number }> {
  const maxFiles = options.maxFiles ?? 30;
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  const hashed: (BackfillTarget & { size: number; lastModified: number; sha256: string })[] = [];
  let bytes = 0;
  for (const target of targets) {
    if (options.shouldStop?.()) break;
    if (hashed.length >= maxFiles) break;
    const stat = await store.stat([target.file]).catch(() => null);
    if (stat?.kind !== "file") continue;
    if (hashed.length > 0 && bytes + stat.size > maxBytes) break;
    try {
      const sha256 = await memo.hash(store, { name: target.file, size: stat.size, lastModified: stat.lastModified });
      hashed.push({ ...target, size: stat.size, lastModified: stat.lastModified, sha256 });
      bytes += stat.size;
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  if (hashed.length === 0 || options.shouldStop?.()) return { written: 0, processed: hashed.length };

  const written = await modifyRecords(store, cfg, async (data) => {
    const latest = latestEntries(data);
    let count = 0;
    for (const h of hashed) {
      const entry = latest.get(h.denpyoNo);
      if (!entry || data.pending[h.denpyoNo] || recordedFileName(cfg, h.denpyoNo, entry) !== h.file) continue;
      const fp = readFingerprint(entry);
      if (fp && fp.pdf_size === h.size && fp.pdf_sha256 === h.sha256) continue;
      const stat = await store.stat([h.file]);
      if (stat?.kind !== "file" || stat.size !== h.size || stat.lastModified !== h.lastModified) continue;
      entry.pdf_size = h.size;
      entry.pdf_sha256 = h.sha256;
      count++;
    }
    return { changed: count > 0, result: count };
  });
  return { written, processed: hashed.length };
}

// ---------------------------------------------------------------------------
// 3. 手で選び直す（指紋を付ける前に名前を変えてしまった分）
// ---------------------------------------------------------------------------

export interface RelinkCandidate {
  name: string;
  size: number;
  lastModified: number;
  /** 記録の指紋と同じ中身か。指紋が無い記録は null（比べられない） */
  sameContent: boolean | null;
}

/** 記録の日時（移植元の書き方 2026-09-13T09:05:07）。読めなければ null */
function parseStamp(at: unknown): number | null {
  if (typeof at !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(at);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 保存済みで「ファイルなし」の伝票について、選べるPDF（どの記録にも使われていないもの） */
export async function relinkCandidates(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  memo: HashMemo,
): Promise<RelinkCandidate[]> {
  const records = await readRecords(store, cfg);
  if (!records.done.includes(denpyoNo) || records.pending[denpyoNo]) {
    throw new RelinkError("notSaved", `伝票 ${denpyoNo} は保存済みの記録ではありません`);
  }
  const entry = latestEntries(records).get(denpyoNo);
  const fp = readFingerprint(entry);
  const claimed = claimedNames(records, cfg);
  const others = await otherKindClaims(store, cfg);
  const files = (await rootPdfs(store)).filter((f) => !claimed.has(nameKey(f.name)) && !others.has(nameKey(f.name)));

  const out: RelinkCandidate[] = [];
  for (const file of files) {
    let sameContent: boolean | null = null;
    if (fp) {
      sameContent = file.size === fp.pdf_size ? (await memo.hash(store, file).catch(() => "")) === fp.pdf_sha256 : false;
    }
    out.push({ ...file, sameContent });
  }
  // 中身が同じもの → 取得した日時に近いもの（指紋の無い記録の手がかり） → 名前順
  const at = parseStamp(entry?.at);
  return out.sort((a, b) => {
    const rank = (c: RelinkCandidate) => (c.sameContent === true ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (at !== null) {
      const d = Math.abs(a.lastModified - at) - Math.abs(b.lastModified - at);
      if (d !== 0) return d;
    }
    return nameCollator.compare(a.name, b.name);
  });
}

/** 選んだPDFを、その伝票の記録に結ぶ。★確かめてから書く（あるか・ほかの記録が使っていないか） */
export async function relinkRecord(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  name: string,
  memo: HashMemo,
  now: Date,
): Promise<void> {
  if (typeof name !== "string" || !/\.pdf$/i.test(name) || /[\\/]/.test(name) || name.startsWith(".")) {
    throw new RelinkError("invalid", "保存先フォルダーの直下にあるPDFを選んでください");
  }
  const records = await readRecords(store, cfg);
  if (!records.done.includes(denpyoNo) || records.pending[denpyoNo]) {
    throw new RelinkError("notSaved", `伝票 ${denpyoNo} は保存済みの記録ではありません`);
  }
  const entry = latestEntries(records).get(denpyoNo);
  const current = recordedFileName(cfg, denpyoNo, entry);
  if ((await store.stat([current]))?.kind === "file") {
    throw new RelinkError("notMissing", `記録のファイル（${current}）は保存先にあります。選び直す必要はありません`);
  }
  const stat = await store.stat([name]);
  if (stat?.kind !== "file") {
    throw new RelinkError("notFound", `「${name}」が保存先フォルダーの直下に見つかりません（一覧を読み込み直してください）`);
  }
  const claimedBy = (data: ProcessedData): string | null => {
    const latest = latestEntries(data);
    for (const no of data.done) {
      if (no !== denpyoNo && nameKey(recordedFileName(cfg, no, latest.get(no))) === nameKey(name)) return no;
    }
    return null;
  };
  const other = claimedBy(records);
  if (other) throw new RelinkError("claimed", `「${name}」はほかの記録（伝票No. ${other}）のファイルです`);
  if ((await otherKindClaims(store, cfg)).has(nameKey(name))) {
    throw new RelinkError("claimed", `「${name}」はほかの種類の記録のファイルです`);
  }
  const sha256 = await memo.hash(store, { name, size: stat.size, lastModified: stat.lastModified });

  await modifyRecords(store, cfg, async (data) => {
    const latest = latestEntries(data);
    const fresh = latest.get(denpyoNo);
    const again = await store.stat([name]);
    if (
      !fresh ||
      !data.done.includes(denpyoNo) ||
      data.pending[denpyoNo] ||
      recordedFileName(cfg, denpyoNo, fresh) !== current ||
      claimedBy(data) !== null ||
      again?.kind !== "file" ||
      again.size !== stat.size ||
      again.lastModified !== stat.lastModified
    ) {
      throw new RelinkError("changed", "選んでいる間に記録かPDFが変わりました。一覧を読み込み直してから、もう一度選んでください");
    }
    linkEntry(fresh, cfg, name, { pdf_size: stat.size, pdf_sha256: sha256 }, now);
    return { changed: true, result: undefined };
  });
}
