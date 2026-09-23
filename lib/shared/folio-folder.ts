/**
 * Folio フォルダーの中の置き場所を決める。
 *
 * ★フォルダーを選ぶのは**1回だけ**にする（利用者の決定 2026-09-23）。
 *   以前はアフター・顛末書・専決決裁書・捺印決裁書の4か所で別々に選んでいた。
 *
 *   Folio/
 *     _data/        … 2人で分け合うデータ（lib/shared/datasets.ts）
 *     顛末書/        … 取得したPDFと記録（_記録）
 *     専決決裁書/
 *     捺印決裁書/
 *
 * ★書類のフォルダーは**無ければ作る**。
 * ★Box でフォルダーの名前が変えられても行き止まりにしない。名前で見つからないときは
 *   中の `_記録/processed*.json` を手がかりに探し、「こちらを使いますか」と尋ねる
 *   （勝手に切り替えない。別の書類のフォルダーを掴むと記録が混ざるため）。
 */
import { LOCAL_KINDS, RECORDS_DIR } from "@/lib/tenmatsu/local/kind-config";
import type { FolderStore, Path } from "@/lib/tenmatsu/local/fs";
import type { DocKind } from "@/lib/tenmatsu/kinds";

/** その書類のフォルダーの既定の名前（画面に出る名前と同じにする） */
export const defaultKindDirName = (kind: DocKind): string => kind.label;

/** そのフォルダーが、その書類の記録を持っているか（名前が変わっていても見分けられる） */
export async function holdsKindRecords(
  store: FolderStore,
  dir: string,
  kind: DocKind,
): Promise<boolean> {
  const file = LOCAL_KINDS[kind.id].processedFile;
  return await store.exists([dir, RECORDS_DIR, file]);
}

export interface KindDirState {
  /** いま使うフォルダーの名前 */
  name: string;
  /** 作ったばかり（まだ何も入っていない） */
  created: boolean;
  /**
   * 別の名前のフォルダーに、この書類の記録が見つかった。
   * ★勝手に切り替えず、画面で選んでもらう。
   */
  candidates: string[];
}

/**
 * その書類のフォルダーを決める。無ければ作る。
 * `saved` は前に使った名前（利用者が名前を変えたあとに選び直した分）。
 */
export async function resolveKindDir(
  store: FolderStore,
  kind: DocKind,
  saved: string | null,
): Promise<KindDirState> {
  const dirs = (await store.list([])).filter((e) => e.kind === "directory").map((e) => e.name);
  const preferred = [saved, defaultKindDirName(kind)].filter((n): n is string => !!n);
  for (const name of preferred) {
    if (dirs.includes(name)) return { name, created: false, candidates: [] };
  }
  // 名前では見つからない。記録を手がかりに探す（名前が変えられた可能性）
  const candidates: string[] = [];
  for (const dir of dirs) {
    if (dir === "_data" || dir.startsWith(".")) continue;
    if (await holdsKindRecords(store, dir, kind)) candidates.push(dir);
  }
  const name = defaultKindDirName(kind);
  if (candidates.length === 0) {
    // ★無ければ作る（選ばせない）
    await store.ensureDir([name]);
    return { name, created: true, candidates: [] };
  }
  // 候補があるときは作らない（作ると空の一覧が出て、記録が消えたように見える）
  return { name, created: false, candidates: candidates.sort() };
}

/** 「名前が変わっていませんか」の文 */
export function renamedDirText(kind: DocKind, candidates: readonly string[]): string {
  const list = candidates.map((c) => `「${c}」`).join("・");
  return (
    `Folio フォルダーの中に「${defaultKindDirName(kind)}」がありませんが、` +
    `${list}に${kind.label}の記録が見つかりました。フォルダーの名前が変わっていませんか。` +
    "使うフォルダーを選んでください（選ぶまで取得はできません）。"
  );
}

/** 引っ越しの案内 */
export function moveInText(kind: DocKind, from: string, files: number): string {
  return `前の保存先「${from}」に ${files.toLocaleString()}件 のファイルがあります。Folio フォルダーの「${defaultKindDirName(kind)}」へ移せます（移すまで前のフォルダーは消しません）。`;
}

export function movedText(kind: DocKind, files: number): string {
  return `前の保存先から ${files.toLocaleString()}件 を「${defaultKindDirName(kind)}」へ移しました。前のフォルダーはそのまま残してあるので、確かめてから消してください。`;
}

/**
 * 別のフォルダー（別の保存先）へ、中身をまるごと写す。
 * ★消さない。写してから利用者に確かめてもらう（取り違えたら戻せないため）。
 */
export async function copyAcross(from: FolderStore, to: FolderStore, path: Path = []): Promise<number> {
  let copied = 0;
  for (const entry of await from.list(path)) {
    const next = [...path, entry.name];
    if (entry.kind === "directory") {
      await to.ensureDir(next);
      copied += await copyAcross(from, to, next);
      continue;
    }
    // ★同じ名前がもうあれば上書きしない（あとから移した分で前の分を潰さない）
    if (await to.exists(next)) continue;
    await to.writeBytes(next, await from.readBytes(next));
    copied += 1;
  }
  return copied;
}

/** 中にいくつファイルがあるか（引っ越しの案内に出す） */
export async function countFiles(store: FolderStore, path: Path = []): Promise<number> {
  let n = 0;
  for (const entry of await store.list(path)) {
    if (entry.kind === "directory") n += await countFiles(store, [...path, entry.name]);
    else n += 1;
  }
  return n;
}
