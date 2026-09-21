/**
 * 「使い方」ページの写真に写す**架空のデータ**。ここだけを見れば、何が写るか分かるようにする。
 *
 * ★実在の氏名・住所・電話番号・伝票№・社員番号・PJ を書かない（公開リポジトリ。履歴から消せない）。
 *   使ってよい形は tests/help-shots-fixtures.test.ts が見張る:
 *   氏名は「山田　太郎」か「架空　…」、住所は「架空」を含む、電話は 090-0000-/080-0000-、
 *   伝票№は TE/SE/NK + 0000900x、PJ は 21012301xx。
 * ★見本の出どころ: tests/after-store.test.ts（顧客）・tests/tenmatsu-list-view.test.ts（伝票）・
 *   lib/inspection-flow.ts の FILENAME_EXAMPLE（ファイル名）。
 */
import { COLUMNS } from "@/lib/tsv";

/** 写真を撮る日（表示される日付を毎回同じにする） */
export const SHOT_DATE = "2026/09/01";

const col = (name: (typeof COLUMNS)[number]): number => COLUMNS.indexOf(name);

/** 24列の行を作る（列が増減しても位置がずれないよう、名前で入れる） */
export function cellsOf(values: Partial<Record<(typeof COLUMNS)[number], string>>): string[] {
  const cells = COLUMNS.map(() => "");
  for (const [name, value] of Object.entries(values)) {
    cells[col(name as (typeof COLUMNS)[number])] = value ?? "";
  }
  return cells;
}

export const TARO = {
  id: "dx:2101230101",
  pj: "2101230101",
  name: "山田　太郎",
  kana: "ヤマダ　タロウ",
  property: "架空台1丁目 A号棟",
  address: "東京都架空区北町1-2-3",
  phone: "090-0000-1234",
  handover: "2025/09/26",
} as const;

export const HANAKO = {
  id: "dx:2101230102",
  pj: "2101230102",
  name: "架空　花子",
  kana: "カクウ　ハナコ",
  property: "架空台2丁目 B号棟",
  address: "東京都架空区南町4-5-6",
  phone: "080-0000-5678",
  handover: "2024/03/15",
} as const;

export const PEOPLE = [TARO, HANAKO] as const;

/** 定期点検のファイル名（lib/inspection-flow.ts の例と同じ書き方） */
export const inspectionFileName = (who: (typeof PEOPLE)[number], kind: "写真報告書" | "点検報告書") =>
  `20260722 【${kind}】${who.name}様邸.PDF`;

/** 顛末書系の伝票（tests/tenmatsu-list-view.test.ts の6件セットと同じ番号） */
export const DENPYO_NOS = ["9001", "9002", "9003", "9004", "9005", "9006"] as const;
