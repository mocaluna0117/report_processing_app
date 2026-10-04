/**
 * 保存データの1行を今の形式に揃える。純関数のみ。
 *
 * 形式を変えるたびに loadResults / loadAfterCases の両方へ同じ手当てを書くと片方を忘れるので、
 * 「古いデータをどう読み替えるか」をこのファイルに集める。冪等 (何度通しても同じ結果)。
 */
import { isCorporateName } from "@/lib/after/normalize";
import { attachSummaries, syncSummaryCell, withoutSummaries } from "@/lib/summary";
import { toHalfWidthSpace } from "@/lib/text";
import { attachTreatments } from "@/lib/treatment";
import { OWNER_COL, PROPERTY_COUNT_COL, PROPERTY_COUNT_MARK } from "@/lib/tsv";
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

/** 氏名の姓名区切りを半角スペースに揃える (前は全角で保存していた)。法人名の空白は変えない */
const halfWidthName = (name: string): string =>
  isCorporateName(name) ? name : toHalfWidthSpace(name);

function withHalfWidthOwner(cells: string[]): string[] {
  const owner = cells[OWNER_COL];
  if (owner === undefined || halfWidthName(owner) === owner) return cells;
  return cells.map((v, i) => (i === OWNER_COL ? halfWidthName(v) : v));
}

/** 保存データの1行 (今は使っていない splitSummary フラグを持っている場合がある) */
type StoredRow = {
  ownerDisplay?: string;
  mail?: { ownerKana: string };
  cells: string[];
  categories: WorkCategoryEntry[];
  /** 物件数の★を扱うようになったあとに保存された行か (lib/process.ts で立てる) */
  propertyCountMarked?: boolean;
  splitSummary?: unknown;
};

/**
 * 読み込んだ1行を今の形式にする。
 * - 物件数: ★を扱う前に保存された行が空欄なら★を入れる (消した★は戻さない)
 * - お客様氏名・カナ: 前は姓名の間を全角スペースで保存していたので半角に直す (法人名はそのまま)
 * - 工事区分2件以上で本文の無い区分があれば、共通のセルから振り分ける (分ける前の形式)
 * - 分けている行は共通のセルを鏡に揃える (フラグ時代は「分ける前の本文」がセルに残っていた)
 * - 1件以下なら区分に残った本文を外す (共通のセルが唯一の本文)
 * - 処置も同じ決まりで揃える (lib/treatment.ts)。行ごとに分ける前の保存データは、共通の処置を先頭の行に入れる
 * - 使わなくなった splitSummary フラグは落とす
 */
export function normalizeStoredRow<R extends StoredRow>(row: R): R {
  const { splitSummary: _legacyFlag, ...rest } = row;
  const cells = withHalfWidthOwner(withPropertyCountMark(row));
  const legacy = row.categories.some((c) => c.summary === undefined);
  const summaries =
    row.categories.length < 2
      ? { cells, categories: withoutSummaries(row.categories) }
      : legacy
        ? attachSummaries(cells, row.categories)
        : { cells: syncSummaryCell(cells, row.categories), categories: row.categories };
  const next = attachTreatments(summaries.cells, summaries.categories);
  const names = {
    ...(row.ownerDisplay !== undefined && { ownerDisplay: halfWidthName(row.ownerDisplay) }),
    ...(row.mail && { mail: { ...row.mail, ownerKana: toHalfWidthSpace(row.mail.ownerKana) } }),
  };
  // 読み替え済みの印を残す (次の読み込みで、消した★を勝手に戻さないため)
  return { ...(rest as unknown as R), ...names, ...next, propertyCountMarked: true };
}
