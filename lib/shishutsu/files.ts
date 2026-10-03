/**
 * 支出報告書で読む表を選ぶ: 共有フォルダー（Box Drive）の中の xlsx を探す・名前で見当を付ける・読む。
 *
 * ★探すのはサブフォルダー3段まで・500件まで（Box の大きなフォルダーで待たせない）。
 * ★Folio のデータ置き場（_data / .data）と、Excel が開いている間の一時ファイル（~$…）は候補にしない。
 */
import type { FolderStore } from "@/lib/tenmatsu/local/fs";

export type SheetSlot = "noSite" | "after" | "inspection" | "end";

export interface FolderXlsx {
  /** フォルダーの中の場所（[サブフォルダー…, ファイル名]） */
  path: string[];
  name: string;
  lastModified: number;
}

const SKIP_DIRS = new Set(["_data", ".data"]);
const MAX_DEPTH = 3;
const MAX_FILES = 500;

export async function listFolderXlsx(store: FolderStore): Promise<FolderXlsx[]> {
  const out: FolderXlsx[] = [];
  const walk = async (dir: string[], depth: number): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    const files = await store.listFiles(dir);
    for (const f of files) {
      if (!/\.xlsx$/i.test(f.name) || f.name.startsWith("~$") || f.name.startsWith(".")) continue;
      out.push({ path: [...dir, f.name], name: f.name, lastModified: f.lastModified });
      if (out.length >= MAX_FILES) return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of await store.list(dir)) {
      if (entry.kind !== "directory" || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk([...dir, entry.name], depth + 1);
    }
  };
  await walk([], 0);
  return out;
}

/** 表の種類ごとの、ファイル名の見当（見本: 2026.4～アフター進捗管理表（8期）.xlsx など） */
const NAME_HINTS: Record<SheetSlot, { must: RegExp; not?: RegExp }> = {
  noSite: { must: /現場対応なし/ },
  after: { must: /アフター.*進捗/, not: /現場対応なし/ },
  inspection: { must: /(年次|定期)点検.*進捗/ },
  end: { must: /エンド立[会合]/ },
};

/** 名前の先頭の年月（「2026.4～…」なら 202604）。無ければ 0 */
function periodOf(name: string): number {
  const m = /(20\d{2})[.\-/年](\d{1,2})/.exec(name.normalize("NFKC"));
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/**
 * 名前で見当を付ける。候補が複数なら、名前の年月（期）が新しいもの → 更新日時が新しいもの。無ければ null。
 * ★更新日時だけで選ぶと、前の期の表をあとから開いて保存しただけで、そちらを選んでしまう
 */
export function guessFile(files: readonly FolderXlsx[], slot: SheetSlot): FolderXlsx | null {
  const hint = NAME_HINTS[slot];
  const hits = files.filter((f) => {
    const name = f.name.normalize("NFKC");
    return hint.must.test(name) && !(hint.not?.test(name) ?? false);
  });
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => periodOf(b.name) - periodOf(a.name) || b.lastModified - a.lastModified)[0];
}

export const pathText = (path: readonly string[]) => path.join(" / ");
