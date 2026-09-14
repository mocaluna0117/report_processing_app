/**
 * 保留・部品のフォルダーの中の「ファイルの並び」（manifest.json）。
 *
 * 移植元: tenmatsu.py 459-835（normalize_slot / part_files / read_manifest / write_manifest / apply_uploads /
 *         merge_order / _record_pages / merge_manifest / _missing_records / _check_slots_filled / _cleanup_parts）
 *
 * ★manifest は「ファイルの並び」専用。値（伝票の項目）は記録（processed*.json）に置き、二重に持たない。
 * ★`pages` は**「いまそのフォルダーが返している PDF の内訳」**。記録するのはその PDF を作った結合のときだけ。
 *   後から足したファイルは pages を持たない＝「これから入る書類」と分かる。
 */
import type { PendingFile } from "@/lib/tenmatsu/client";
import { extOf, fixExtension } from "@/lib/rakuraku/parse/sniff";
import type { FolderStore, Path } from "./fs";
import { MANIFEST_NAME } from "./kind-config";
import { type MergeOutcome, SUPPORTED_ATTACHMENT_TEXT, UPLOADABLE_EXTS, mergeParts } from "./merge";
import { safeComponent, stemOf } from "./naming";

export interface ManifestFile {
  /** フォルダーの中の実ファイル名 */
  file: string;
  /** 利用者が選んだときの名前 */
  name: string;
  pages?: number;
  [key: string]: unknown;
}

export interface ManifestPart {
  index: number;
  name: string;
  /** ok / failed / skipped / replaced / awaiting / uploaded */
  status: string;
  file?: string | null;
  files?: ManifestFile[];
  reason?: string;
  pages?: number;
  uploaded_name?: string;
  [key: string]: unknown;
}

export interface Manifest {
  parts: ManifestPart[];
  merged_pages?: number;
  [key: string]: unknown;
}

/** 保留・差し替えの操作で断るときの理由。画面にそのまま出す */
export type PendingErrorKind =
  /** 保留になっていない */
  | "notPending"
  /** 保存済みの記録が無い */
  | "notSaved"
  /** 部品が残っていない（この機能より前に確定した） */
  | "noParts"
  /** 保留のファイルが見つからない */
  | "noFiles"
  /** 入れ方が正しくない（形式・枠・足りない書類） */
  | "invalid"
  /** 結合できなかった（保留のまま残す） */
  | "mergeFailed"
  /** 保存先に記録の名前のPDFが無い（名前を変えた・消した。差し替えは書かずに止める） */
  | "fileMissing";

export class PendingError extends Error {
  constructor(
    readonly kind: PendingErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PendingError";
  }
}

/** あとから利用者が入れる枠（捺印決裁書）の状態。この枠だけは**複数のファイル**を持てる */
export const SLOT_STATUSES: ReadonlySet<string> = new Set(["awaiting", "uploaded"]);

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * 古い形の枠を今の形（files の並び）に直す。その場で書き換える。
 * ★呼ぶのは読むときだけ。書き戻しは呼ぶ側が必要なときに行う。
 */
export function normalizeSlot(part: ManifestPart): void {
  const status = part.status;
  if (SLOT_STATUSES.has(status)) {
    part.files = (part.files ?? []).filter((f) => Boolean(f.file));
    delete part.file;
    part.status = part.files.length > 0 ? "uploaded" : "awaiting";
  } else if (status === "replaced" && Number(part.index) === 0) {
    // 旧サーバーで1つだけ入れたあと結合に失敗した枠。★元の名前は残っていないのでファイル名を使う
    const name = part.file;
    part.files = name ? [{ file: name, name: name.replace(/^\d{3}_(\d{2}_)?/, "") }] : [];
    part.status = name ? "uploaded" : "awaiting";
    delete part.file;
  }
}

/** その部品を結合するときのファイル名（並び順）。欠け（failed）と空の枠（awaiting）は結合しない */
export function partFiles(part: ManifestPart): string[] {
  if (part.status === "uploaded") return (part.files ?? []).filter((f) => f.file).map((f) => f.file);
  if (part.status === "failed" || part.status === "awaiting") return [];
  return part.file ? [part.file] : [];
}

/** その部品に利用者が入れたファイルの名前（記録の replaced_attachments 用） */
export function partUploadedNames(part: ManifestPart): string[] {
  if (part.status === "uploaded") return (part.files ?? []).filter((f) => f.file).map((f) => f.name || f.file);
  if (part.status === "replaced") {
    const name = part.uploaded_name || part.file;
    return name ? [name] : [];
  }
  return [];
}

const byIndex = (parts: readonly ManifestPart[]) => [...parts].sort((a, b) => Number(a.index) - Number(b.index));

/**
 * フォルダーの manifest を読む。無ければ PendingError（呼ぶ側が案内を出す）。
 * composed を真にすると、あとから入れる枠を今の形に直して返す。
 * ★直すのは組み立てる種類（捺印決裁書）だけ。顛末書の index 0 は本体なので、同じ規則で触ると本体を枠として扱ってしまう。
 */
export async function readManifest(store: FolderStore, dir: Path, options: { composed: boolean; missing: PendingErrorKind }): Promise<Manifest> {
  const path = [...dir, MANIFEST_NAME];
  if (!(await store.exists(path))) {
    throw new PendingError(
      options.missing,
      options.missing === "noParts"
        ? "この記録には部品が残っていないので差し替えられません（この機能より前に確定したものです）"
        : "保留中のファイルが見つかりません。「取り消して次回取り直す」を押してください",
    );
  }
  const manifest = JSON.parse(await store.readText(path)) as Manifest;
  if (!Array.isArray(manifest.parts)) throw new PendingError(options.missing, "保留中のファイルの並びが読めません");
  if (options.composed) for (const part of manifest.parts) normalizeSlot(part);
  return manifest;
}

export async function writeManifest(store: FolderStore, dir: Path, manifest: Manifest): Promise<void> {
  await store.writeBytes([...dir, MANIFEST_NAME], JSON.stringify(manifest, null, 2));
}

/**
 * 入れられるファイルか（名前の拡張子で）。拡張子を返す。
 * ★中身を見るより先に拡張子で断る。中身の判定は Office を見ないので、ここを通すと結合の直前まで気付けない。
 */
export function uploadExt(name: string): string {
  if (!name) throw new PendingError("invalid", "ファイル名がありません");
  const ext = extOf(name);
  if (!UPLOADABLE_EXTS.has(ext)) {
    throw new PendingError(
      "invalid",
      `${name} は結合できない形式です（入れられるのは ${SUPPORTED_ATTACHMENT_TEXT}。Excel・Word・PowerPoint・メールは手でPDFにしてから入れてください）`,
    );
  }
  return ext;
}

const isKeep = (f: PendingFile): f is Extract<PendingFile, { keep: string }> => "keep" in f;

/**
 * 利用者が入れたファイルを manifest とフォルダーへ反映する（manifest はその場で書き換える）。
 *
 * uploads の要素は「新しく入れる {index, name, bytes}」か「いま入っているものをこの位置に残す {index, keep}」。
 * slots は「最終状態をこの1回で全部指定した枠」の index。★枠は**同じ index の要素を並べたものが最終状態**で、
 * 並びも外したファイルもこれで決まる（途中の状態を持たない）。slots に入れた枠は、要素が無ければ空になる。
 *
 * ★**検査を全部先に済ませてから書く**。3件目が結合できない形式だったときに1・2件目だけ書かれると、
 *   画面に出ている内容と中身がずれる。
 */
export async function applyUploads(
  store: FolderStore,
  dir: Path,
  manifest: Manifest,
  uploads: readonly PendingFile[] = [],
  slots: readonly number[] = [],
): Promise<void> {
  const parts = new Map(manifest.parts.map((p) => [Number(p.index), p]));
  const grouped = new Map<number, PendingFile[]>();

  for (const index of slots) {
    const part = Number.isInteger(index) ? parts.get(index) : undefined;
    if (!part) throw new PendingError("invalid", `${index} 番の添付はありません`);
    if (!SLOT_STATUSES.has(part.status)) throw new PendingError("invalid", `${part.name} は書類を並べる枠ではありません`);
    grouped.set(index, []);
  }
  for (const up of uploads) {
    const part = Number.isInteger(up.index) ? parts.get(up.index) : undefined;
    if (!part) throw new PendingError("invalid", `${up.index} 番の添付はありません`);
    const same = grouped.get(up.index) ?? [];
    grouped.set(up.index, same);
    if (SLOT_STATUSES.has(part.status)) {
      if (isKeep(up)) {
        if (!(part.files ?? []).some((f) => f.file === up.keep)) {
          throw new PendingError("invalid", `${up.keep} は${part.name}の枠にありません`);
        }
        if (same.some((other) => isKeep(other) && other.keep === up.keep)) {
          throw new PendingError("invalid", `${up.keep} が2回指定されています`);
        }
      } else {
        uploadExt(up.name.trim());
      }
    } else if (part.status === "failed" || part.status === "replaced") {
      // ★一度入れ直したもの（replaced）も、また入れ直せるようにする（結合に失敗したあとで詰まないように）
      if (isKeep(up)) throw new PendingError("invalid", `${part.name} は書類を並べる枠ではありません`);
      if (same.length > 0) throw new PendingError("invalid", `${part.name} に入れられるのは1つだけです`);
      uploadExt(up.name.trim());
    } else {
      throw new PendingError("invalid", `${part.name} は欠けていないので差し替えられません`);
    }
    same.push(up);
  }

  // ここから書く
  const used = new Set((await store.list(dir)).map((e) => e.name));
  for (const [index, ups] of grouped) {
    const part = parts.get(index)!;
    if (SLOT_STATUSES.has(part.status)) {
      const existing = new Map((part.files ?? []).filter((f) => f.file).map((f) => [f.file, f]));
      const files: ManifestFile[] = [];
      for (const up of ups) {
        if (isKeep(up)) {
          files.push(existing.get(up.keep)!);
          continue;
        }
        const name = up.name.trim();
        const dest = slotDest(used, index, name, uploadExt(name), up.bytes);
        await store.writeBytes([...dir, dest], up.bytes);
        used.add(dest);
        files.push({ file: dest, name });
      }
      // 最終状態に入っていない元のファイルは消す（利用者が「外す」と言ったもの）
      const keep = new Set(files.map((f) => f.file));
      for (const oldName of existing.keys()) {
        if (!keep.has(oldName)) {
          await store.remove([...dir, oldName]);
          used.delete(oldName);
        }
      }
      part.files = files;
      part.status = files.length > 0 ? "uploaded" : "awaiting";
      delete part.file;
      if (files.length > 0) delete part.reason;
    } else {
      const up = ups[0] as Extract<PendingFile, { bytes: Uint8Array }>;
      const name = up.name.trim();
      if (part.file) {
        await store.remove([...dir, part.file]);
        used.delete(part.file);
      }
      const dest = fixExtension(`${pad(index, 3)}_${safeComponent(stemOf(name))}${uploadExt(name)}`, up.bytes);
      await store.writeBytes([...dir, dest], up.bytes);
      used.add(dest);
      part.file = dest;
      part.status = "replaced";
      // ★前の結合のページ数は捨てる（このファイルはまだ PDF に入っていない）
      delete part.pages;
      // ★入れたファイルの名前を残す。結合に失敗して開き直したときも、記録に元の名前を書けるように
      part.uploaded_name = name;
      delete part.reason;
    }
  }
}

/**
 * 枠に入れるファイルの名前。同じ枠の中でぶつからないように連番を付ける（`{index:03}_{連番:02}_{名前}`）。
 * 拡張子は中身で直す。
 */
function slotDest(used: ReadonlySet<string>, index: number, name: string, ext: string, bytes: Uint8Array): string {
  for (let seq = 1; seq < 100; seq++) {
    const candidate = `${pad(index, 3)}_${pad(seq, 2)}_${safeComponent(stemOf(name))}${ext}`;
    const fixed = fixExtension(candidate, bytes);
    if (!used.has(candidate) && !used.has(fixed)) return fixed;
  }
  throw new PendingError("invalid", "1つの枠に入れられるのは99個までです");
}

/** 結合する順（index 昇順、枠の中は入れた並び） */
export function mergeOrder(parts: readonly ManifestPart[]): string[] {
  return byIndex(parts).flatMap(partFiles);
}

/**
 * 結合した部品ごとのページ数を parts へ書き込む（その場で書き換える）。
 * files / pageCounts は結合に渡した順そのまま。
 */
export function recordPages(parts: ManifestPart[], files: readonly string[], pageCounts: readonly number[]): void {
  const counts = new Map<string, number>();
  files.forEach((file, i) => counts.set(file, pageCounts[i] ?? 0));
  for (const part of parts) {
    if (SLOT_STATUSES.has(part.status)) {
      for (const f of part.files ?? []) if (f.file) f.pages = counts.get(f.file) ?? 0;
      delete part.pages; // 枠自体は files の合計なので持たせない
    } else {
      part.pages = part.file ? (counts.get(part.file) ?? 0) : 0;
    }
  }
}

/**
 * manifest の並びで結合し、部品ごとのページ数を manifest へ記録する。
 * ★結合に失敗したときは manifest を触らない（前の内訳がそのまま残る）。失敗は mergeFailed。
 */
export async function mergeManifest(
  store: FolderStore,
  dir: Path,
  manifest: Manifest,
  options: { strictFirst?: boolean } = {},
): Promise<MergeOutcome> {
  const files = mergeOrder(manifest.parts);
  let outcome: MergeOutcome;
  try {
    const parts = [];
    for (const file of files) parts.push({ name: file, bytes: await store.readBytes([...dir, file]) });
    outcome = await mergeParts(parts, { strictFirst: options.strictFirst });
  } catch (e) {
    if (e instanceof PendingError) throw e;
    throw new PendingError("mergeFailed", e instanceof Error ? e.message : String(e));
  }
  recordPages(manifest.parts, files, outcome.pageCounts);
  manifest.merged_pages = outcome.totalPages;
  return outcome;
}

/** 利用者が入れたファイルの名前を、結合する順に並べる */
export function uploadedNames(parts: readonly ManifestPart[]): string[] {
  return byIndex(parts).flatMap(partUploadedNames);
}

/** 欠けたまま確定した添付（記録に残す形） */
export function missingRecords(parts: readonly ManifestPart[]): { index: number; name: string; reason: string | null }[] {
  return byIndex(parts)
    .filter((p) => p.status === "failed")
    .map((p) => ({ index: Number(p.index), name: p.name, reason: p.reason ?? null }));
}

/**
 * あとから入れる枠が空なら断る。
 * ★「結合できなかった添付」と違って最初から利用者が入れる前提の枠なので、入っていなければ書類として
 *   成り立たない（捺印決裁書）。欠けたまま確定する指定でも通さない。
 */
export function checkSlotsFilled(parts: readonly ManifestPart[]): void {
  const empty = parts.filter((p) => p.status === "awaiting");
  if (empty.length > 0) throw new PendingError("invalid", `${empty.map((p) => p.name).join("、")} をアップロードしてください`);
}

/** manifest に載っていないファイル（外したもの・結合の途中のもの）を消す */
export async function cleanupParts(store: FolderStore, dir: Path, manifest: Manifest): Promise<void> {
  const keep = new Set([MANIFEST_NAME]);
  for (const part of manifest.parts) {
    for (const f of part.files ?? []) if (f.file) keep.add(f.file);
    if (part.file) keep.add(part.file);
  }
  for (const entry of await store.list(dir)) {
    if (!keep.has(entry.name)) await store.remove([...dir, entry.name], { recursive: true });
  }
}
