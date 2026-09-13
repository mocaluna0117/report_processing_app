/**
 * 画面の一覧（取得済み・保留中）を、フォルダーの中の記録と実物から組み立てる。
 *
 * 移植元: tenmatsu.py 3813-4076（_present_* / _pdf_stats / _slot_files_view / _pending_missing /
 *         _read_upload_slots / _pdf_layout / list_processed_files）
 *
 * ★記録があってもファイルが消えていれば exists=false で返す（黙って隠さない）。
 * ★並びは ①保留中（新しい順）→ ②保存済み（記録に足した順の逆）。両者は**同じキーを全部持つ**。
 * ★物件名・監督・営業は、記録に残した生の値から**読むときに取り出す**（規則を直しても取り直さずに済む）。
 */
import { KINDS } from "@/lib/rakuraku/kinds";
import { parseLabeledField, parsePropertyName, parseStaffNames } from "@/lib/rakuraku/parse/fields";
import type { ListItem, MissingAttachment, PdfLayoutEntry, UploadSlot, UploadedFile } from "@/lib/tenmatsu/client";
import type { FolderStore, Path } from "./fs";
import { type LocalKindConfig, PENDING_MERGED_NAME } from "./kind-config";
import { type Manifest, type ManifestPart, SLOT_STATUSES, readManifest } from "./manifest";
import { countPdfPages } from "./merge";
import { last4, safeComponent } from "./naming";
import { type ProcessedData, partsDirPath, pendingDirPath, readRecords } from "./records";

/**
 * PDF のページ数の控え。大きさと更新日時が同じ間は数え直さない（移植元は一覧のたびに全 PDF を開いていた）。
 * 画面では IndexedDB に置く。検証ではメモリに置く。
 */
export interface StatsCache {
  get(key: string): Promise<number | null | undefined>;
  set(key: string, pages: number | null): Promise<void>;
}

export function memoryStatsCache(): StatsCache {
  const map = new Map<string, number | null>();
  return {
    get: async (key) => map.get(key),
    set: async (key, pages) => {
      map.set(key, pages);
    },
  };
}

export interface PdfStats {
  exists: boolean;
  pages: number | null;
  size: number | null;
}

/** PDF の有無・ページ数・大きさ。読めないページ数は null（黙って 0 にしない） */
export async function pdfStats(store: FolderStore, path: Path, cache: StatsCache): Promise<PdfStats> {
  const stat = await store.stat(path);
  if (!stat || stat.kind !== "file") return { exists: false, pages: null, size: null };
  const key = `${path.join("/")}|${stat.size}|${stat.lastModified}`;
  const cached = await cache.get(key);
  if (cached !== undefined) return { exists: true, pages: cached, size: stat.size };
  let pages: number | null = null;
  try {
    pages = await countPdfPages(await store.readBytes(path));
  } catch {
    pages = null;
  }
  await cache.set(key, pages);
  return { exists: true, pages, size: stat.size };
}

type Entry = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const list = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 ? value.filter((x): x is string => typeof x === "string") : null;

/** 種類ごとに行へ足す項目。★その書類に無い項目はキーごと返さない */
function present(cfg: LocalKindConfig, entry: Entry): Partial<ListItem> {
  const detail = KINDS[cfg.id].detail;
  const label = detail.propertyNameLabel ?? "物件名";
  switch (cfg.id) {
    case "tenmatsu": {
      const where = text(entry.where);
      return {
        amount: text(entry.amount),
        payee: text(entry.payee),
        property_name: parsePropertyName(where),
        pj: text(entry.pj),
        ...parseStaffNames(where),
      };
    }
    case "senketsu":
      return {
        title: text(entry.title),
        payee: text(entry.payee),
        amount: text(entry.amount),
        property_name: parseLabeledField(text(entry.content), label),
      };
    case "natsuin":
      return {
        content: text(entry.content),
        senketsu_no: text(entry.senketsu_no),
        payee: text(entry.payee),
        amount: text(entry.amount),
        property_name: parseLabeledField(text(entry[detail.propertyNameSource ?? "content"]), label),
      };
  }
}

async function slotFilesView(store: FolderStore, dir: Path, part: ManifestPart): Promise<UploadedFile[]> {
  const out: UploadedFile[] = [];
  for (const f of part.files ?? []) {
    if (!f.file) continue;
    const stat = await store.stat([...dir, f.file]);
    out.push({
      file: f.file,
      name: f.name || f.file,
      size: stat?.kind === "file" ? stat.size : null,
      // 結合したときのページ数。null は「まだ PDF に入っていない・分からない」
      pages: Number.isInteger(f.pages) ? (f.pages as number) : null,
    });
  }
  return out;
}

async function tryManifest(store: FolderStore, dir: Path, cfg: LocalKindConfig): Promise<Manifest | null> {
  try {
    return await readManifest(store, dir, { composed: cfg.composed, missing: "noFiles" });
  } catch {
    return null;
  }
}

const sortedParts = (parts: readonly ManifestPart[]) => [...parts].sort((a, b) => Number(a.index) - Number(b.index));

/**
 * 保留中の伝票の「足りないもの・入れる枠」を manifest から作る。読めなければ null（呼ぶ側が記録の写しを使う）。
 * ★記録の missing は保留にした時点の写しなので、枠に書類を入れて結合だけ失敗した行が「まだ空」に見えてしまう。
 */
async function pendingMissing(store: FolderStore, dir: Path, cfg: LocalKindConfig): Promise<MissingAttachment[] | null> {
  const manifest = await tryManifest(store, dir, cfg);
  if (!manifest) return null;
  const out: MissingAttachment[] = [];
  for (const part of sortedParts(manifest.parts)) {
    const index = Number(part.index);
    if (SLOT_STATUSES.has(part.status)) {
      out.push({ index, name: part.name, reason: part.reason ?? "", awaiting: true, files: await slotFilesView(store, dir, part) });
    } else if (part.status === "failed") {
      out.push({ index, name: part.name, reason: part.reason ?? "" });
    } else if (part.status === "replaced") {
      // ★入れ直したのに結合できなかった枠。ここを出さないと別のファイルを選び直せなくなる
      const stat = part.file ? await store.stat([...dir, part.file]) : null;
      out.push({
        index,
        name: part.name,
        reason: "入れ直したファイルが入っています（このまま確定するか、別のファイルを選べます）",
        filled: { name: part.uploaded_name || part.file || "", size: stat?.kind === "file" ? stat.size : null },
      });
    }
  }
  // 移植元は空の並びを「読めなかった」とみなして記録の写しを使っていた。同じにする
  return out.length > 0 ? out : null;
}

async function uploadSlots(store: FolderStore, dir: Path, cfg: LocalKindConfig): Promise<UploadSlot[] | null> {
  const manifest = await tryManifest(store, dir, cfg);
  if (!manifest) return null;
  const out: UploadSlot[] = [];
  for (const part of sortedParts(manifest.parts)) {
    if (SLOT_STATUSES.has(part.status)) out.push({ index: Number(part.index), name: part.name, files: await slotFilesView(store, dir, part) });
  }
  return out;
}

/**
 * いま返している PDF の内訳（どのページが誰のものか）。次のときは null（★推測しない）:
 * manifest が無い・壊れている／内訳を持たない古い記録／内訳の合計が実物のページ数と合わない
 */
async function pdfLayout(store: FolderStore, dir: Path, base: Path, cfg: LocalKindConfig, cache: StatsCache): Promise<PdfLayoutEntry[] | null> {
  const manifest = await tryManifest(store, dir, cfg);
  if (!manifest || !Number.isInteger(manifest.merged_pages)) return null;
  const out: PdfLayoutEntry[] = [];
  let total = 0;
  for (const part of sortedParts(manifest.parts)) {
    const index = Number(part.index);
    if (SLOT_STATUSES.has(part.status)) {
      for (const f of part.files ?? []) {
        if (!Number.isInteger(f.pages) || (f.pages as number) <= 0) continue; // 結合の後で入れたもの
        out.push({ index, name: f.name || f.file, file: f.file, pages: f.pages as number });
        total += f.pages as number;
      }
    } else {
      // ★欠け・飛ばした添付も 0 ページとして残す（位置が分かるように）
      const pages = Number.isInteger(part.pages) ? (part.pages as number) : 0;
      out.push({ index, name: part.name ?? null, pages });
      total += pages;
    }
  }
  const { pages } = await pdfStats(store, base, cache);
  if (pages === null || total !== pages) return null;
  return out;
}

/** 取得済み・保留中の一覧（画面の表示用） */
export async function buildListItems(
  store: FolderStore,
  cfg: LocalKindConfig,
  cache: StatsCache,
  data?: ProcessedData,
): Promise<ListItem[]> {
  const records = data ?? (await readRecords(store, cfg));
  if (records.done.length === 0 && Object.keys(records.pending).length === 0) return [];

  // 同じ伝票が複数回記録されている場合は最後の記録を採る
  const latest = new Map<string, Entry>();
  for (const entry of records.log) if (entry.denpyo_no) latest.set(entry.denpyo_no, entry);

  const saved: ListItem[] = [];
  for (const no of records.done) {
    const entry = latest.get(no) ?? {};
    const name = text(entry.file) || `${cfg.filePrefix}${last4(no)}.pdf`;
    const stats = await pdfStats(store, [name], cache);
    const flags = records.flags[no] ?? {};
    const values = Object.fromEntries(cfg.flagKeys.map((key) => [key, flags[key] === true]));
    saved.push({
      denpyo_no: no,
      file: name,
      at: text(entry.at),
      ...stats,
      ...values,
      completed: Object.values(values).every(Boolean),
      flags_updated_at: text(flags.updated_at),
      shinsei_date: text(entry.shinsei_date),
      shinseisha: text(entry.shinseisha),
      ...present(cfg, entry),
      final_approved_at: text(entry.final_approved_at),
      skipped_attachments: list(entry.skipped_attachments),
      pending: false,
      missing_attachments: Array.isArray(entry.missing_attachments) && entry.missing_attachments.length > 0 ? (entry.missing_attachments as MissingAttachment[]) : null,
      replaced_attachments: list(entry.replaced_attachments),
      ...(cfg.keepParts
        ? {
            upload_slots: await uploadSlots(store, partsDirPath(safeComponent(no)), cfg),
            pdf_layout: await pdfLayout(store, partsDirPath(safeComponent(no)), [name], cfg, cache),
          }
        : {}),
      recomposed_at: text(entry.recomposed_at),
    });
  }
  saved.reverse(); // 新しいものを先頭に

  // ★保留中の伝票を先頭に置く（作業が残っている行なので最初に目に入るように）
  const held: ListItem[] = [];
  const pendingEntries = Object.entries(records.pending).sort(([, a], [, b]) => ((b.at ?? "") > (a.at ?? "") ? 1 : (b.at ?? "") < (a.at ?? "") ? -1 : 0));
  for (const [no, info] of pendingEntries) {
    const meta = (info.meta ?? {}) as Entry;
    const dir = pendingDirPath(info.dir || no);
    const merged: Path = [...dir, PENDING_MERGED_NAME];
    const stats = await pdfStats(store, merged, cache);
    held.push({
      denpyo_no: no,
      // 確定したときに付く予定の名前（まだこのファイルは無い）
      file: text(meta.final_name) || `${cfg.filePrefix}${last4(no)}.pdf`,
      at: text(info.at),
      ...stats,
      ...Object.fromEntries(cfg.flagKeys.map((key) => [key, false])),
      completed: false,
      flags_updated_at: null,
      shinsei_date: text(meta.shinsei_date),
      shinseisha: text(meta.shinseisha),
      ...present(cfg, meta),
      final_approved_at: text(meta.final_approved_at),
      skipped_attachments: list(meta.skipped_attachments),
      pending: true,
      missing_attachments: (await pendingMissing(store, dir, cfg)) ?? (Array.isArray(info.missing) ? (info.missing as MissingAttachment[]) : []),
      replaced_attachments: null,
      recomposed_at: null,
      pdf_layout: await pdfLayout(store, dir, merged, cfg, cache),
    });
  }
  return [...held, ...saved];
}
