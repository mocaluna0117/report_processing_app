/**
 * 処置 (転記先シートの「処置」列) の扱い。純関数のみ (2026-09-25)。
 *
 * 持ち方は点検内容と同じく工事区分の数で決まる (切り替えのボタンは無い):
 * - 工事区分が1件以下: cells[TREATMENT_COL] が唯一の処置
 * - 2件以上: categories[k].treatment に行ごとの処置が入り、Excelへ展開した行ごとに別の処置が貼られる。
 *   cells[TREATMENT_COL] は、空でない行の処置を区分の順に改行でつないだ「鏡」に保つ (隠れた原本を作らないため)
 */
import { TREATMENT_COL } from "@/lib/tsv";

type WithTreatment = { treatment?: string };

/** 行ごとの処置を1つにまとめる (空の行は飛ばし、区分の順に改行でつなぐ) */
export function mergeTreatments(categories: readonly WithTreatment[]): string {
  return categories
    .map((c) => (c.treatment ?? "").trim())
    .filter((t) => t !== "")
    .join("\n");
}

/** 各区分から処置を外す (工事区分が1件以下になったとき。共通のセルが唯一の処置になる) */
export function withoutTreatments<C extends WithTreatment>(categories: readonly C[]): C[] {
  return categories.map((c) => {
    const next = { ...c };
    delete next.treatment;
    return next;
  });
}

/** 共通のセルを各行の処置の鏡に揃える。2件未満なら分けていないので触らない (同じ配列を返す) */
export function syncTreatmentCell(cells: string[], categories: readonly WithTreatment[]): string[] {
  if (categories.length < 2) return cells;
  const merged = mergeTreatments(categories);
  if (cells[TREATMENT_COL] === merged) return cells;
  return cells.map((c, i) => (i === TREATMENT_COL ? merged : c));
}

/**
 * 工事区分が2件以上なら各区分に処置を持たせ、共通のセルはその鏡にする。1件以下なら区分から外す。
 * 処理した直後 (processPair)・区分が1件→2件になった編集・古い保存データの読み込みが同じ手順を踏む。
 *
 * - どの区分もまだ処置を持っていないときは、共通のセルの処置を先頭の行に入れ、ほかの行は空欄にする
 *   (同じ処置を全行に写すと、貼り付けたときに全行へ同じ処置が入ったままになるため)
 * - 一部の区分だけ持っていないときは、その区分を空欄にする (共通のセルは鏡なので、配ると二重になる)
 * - 何度通しても同じ結果 (冪等)
 */
export function attachTreatments<C extends WithTreatment>(
  cells: string[],
  categories: readonly C[],
): { cells: string[]; categories: C[] } {
  if (categories.length < 2) return { cells, categories: withoutTreatments(categories) };
  const fresh = categories.every((c) => c.treatment === undefined);
  const next = categories.map((c, i) =>
    c.treatment !== undefined
      ? c
      : { ...c, treatment: fresh && i === 0 ? (cells[TREATMENT_COL] ?? "") : "" },
  );
  return { cells: syncTreatmentCell(cells, next), categories: next };
}
