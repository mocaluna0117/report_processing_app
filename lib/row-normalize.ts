/**
 * 保存データの1行を今の形式に揃える。純関数のみ。
 *
 * 形式を変えるたびに loadResults / loadAfterCases の両方へ同じ手当てを書くと片方を忘れるので、
 * 「古いデータをどう読み替えるか」をこのファイルに集める。冪等 (何度通しても同じ結果)。
 */
import { attachSummaries, syncSummaryCell, withoutSummaries } from "@/lib/summary";
import { PROPERTY_COUNT_COL, PROPERTY_COUNT_MARK } from "@/lib/tsv";
import type { WorkCategoryEntry } from "@/lib/types";

/**
 * 物件数が空欄の「★を入れる前に保存された記録」に★を入れる。
 *
 * 空欄かどうかだけで判断すると、利用者が★を消した行 (この物件は数えない、など) も
 * 読み込みのたびに★が戻ってしまう。★を扱うようになったあとに保存した行には
 * propertyCountMarked を立てておき、その行の空欄は「消した」とみなして触らない。
 */
function withPropertyCountMark(row: StoredRow): string[] {
  if (row.propertyCountMarked === true) return row.cells;
  if (row.cells[PROPERTY_COUNT_COL] !== "") return row.cells;
  return row.cells.map((v, i) => (i === PROPERTY_COUNT_COL ? PROPERTY_COUNT_MARK : v));
}

/** 保存データの1行 (今は使っていない splitSummary フラグを持っている場合がある) */
type StoredRow = {
  cells: string[];
  categories: WorkCategoryEntry[];
  /** 物件数の★を扱うようになったあとに保存された行か (lib/process.ts で立てる) */
  propertyCountMarked?: boolean;
  splitSummary?: unknown;
};

/**
 * 読み込んだ1行を今の形式にする。
 * - 物件数: ★を扱う前に保存された行が空欄なら★を入れる (消した★は戻さない)
 * - 工事区分2件以上で本文の無い区分があれば、共通のセルから振り分ける (分ける前の形式)
 * - 分けている行は共通のセルを鏡に揃える (フラグ時代は「分ける前の本文」がセルに残っていた)
 * - 1件以下なら区分に残った本文を外す (共通のセルが唯一の本文)
 * - 使わなくなった splitSummary フラグは落とす
 */
export function normalizeStoredRow<R extends StoredRow>(row: R): R {
  const { splitSummary: _legacyFlag, ...rest } = row;
  const cells = withPropertyCountMark(row);
  const legacy = row.categories.some((c) => c.summary === undefined);
  const next =
    row.categories.length < 2
      ? { cells, categories: withoutSummaries(row.categories) }
      : legacy
        ? attachSummaries(cells, row.categories)
        : { cells: syncSummaryCell(cells, row.categories), categories: row.categories };
  // 読み替え済みの印を残す (次の読み込みで、消した★を勝手に戻さないため)
  return { ...(rest as unknown as R), ...next, propertyCountMarked: true };
}
