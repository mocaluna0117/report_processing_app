import { describe, expect, it } from "vitest";
import type { ResultRow } from "@/lib/process";
import { DEFAULT_REPORT_OPTIONS } from "@/lib/report/model";
import { mergeSplitSummary } from "@/lib/summary";
import { mergeTreatments } from "@/lib/treatment";
import { COLUMNS, SUMMARY_COL, TREATMENT_COL } from "@/lib/tsv";
import type { Contact, WorkCategoryEntry } from "@/lib/types";
import { useRowEditors } from "@/lib/use-row-editors";

// useRowEditors は React のフックを使わない (更新関数を受け取るだけ) ので、そのまま呼んで確かめる
const cellsWith = (summary: string) =>
  COLUMNS.map((c, i) => (i === SUMMARY_COL ? summary : `v:${c}`));

const MERGED = "①1階洋室のクロスに凹凸\n②玄関サッシの結露";

const makeRow = (over: Partial<ResultRow> = {}): ResultRow => ({
  pairId: "p-1",
  ownerDisplay: "架空 太郎",
  // 工事区分が2件以上のときの不変条件: 各区分に本文があり、共通のセルはその鏡
  cells: cellsWith(MERGED),
  confidences: COLUMNS.map(() => "ok" as const),
  categories: [
    { value: "クロス", confidence: "ok", summary: "1階洋室のクロスに凹凸" },
    { value: "サッシ", confidence: "ok", summary: "玄関サッシの結露" },
  ],
  categoryEngine: "gemini",
  report: DEFAULT_REPORT_OPTIONS,
  mail: { ownerKana: "カクウ　タロウ", kanaConfidence: "ok", kanaAlternatives: [], contacts: [] },
  warnings: [],
  engine: "gemini",
  merged: null,
  mergedName: "",
  error: null,
  ...over,
});

/** 工事区分が1件だけの行 (共通のセルが唯一の本文) */
const singleRow = () =>
  makeRow({
    cells: cellsWith(MERGED),
    categories: [{ value: "クロス", confidence: "ok" }],
  });

/** 1回の編集を適用した結果を返す */
function edit(row: ResultRow, run: (editors: ReturnType<typeof useRowEditors>) => void): ResultRow {
  let current = row;
  const editors = useRowEditors<ResultRow>((_pairId, fn) => {
    current = fn(current);
  });
  run(editors);
  return current;
}

const summaries = (row: ResultRow) => row.categories.map((c: WorkCategoryEntry) => c.summary);
/** 共通のセルが各行の本文の鏡になっているか */
const isMirrored = (row: ResultRow) =>
  row.cells[SUMMARY_COL] === mergeSplitSummary(row.categories);

describe("点検内容は工事区分の数で分かれる", () => {
  it("1件→2件に足すと共通の本文が振り分けられ、セルは鏡になる", () => {
    const next = edit(singleRow(), (e) => e.onCategoryAdd("p-1"));
    expect(next.categories).toHaveLength(2);
    // 足した行は区分が空欄なので、事象はいったん元の行に残る
    expect(summaries(next)).toEqual([MERGED, ""]);
    expect(isMirrored(next)).toBe(true);
  });

  it("0件の行に足すと2件になり、共通の本文が振り分けられる", () => {
    const next = edit(makeRow({ categories: [] }), (e) => e.onCategoryAdd("p-1"));
    expect(next.categories).toHaveLength(2);
    expect(summaries(next)).toEqual([MERGED, ""]);
    expect(isMirrored(next)).toBe(true);
  });

  it("2件以上のときに足した行は本文が空欄で、鏡は変わらない", () => {
    const row = makeRow();
    const next = edit(row, (e) => e.onCategoryAdd("p-1"));
    expect(next.categories).toHaveLength(3);
    expect(next.categories[2]).toMatchObject({ value: "", summary: "" });
    expect(next.cells[SUMMARY_COL]).toBe(row.cells[SUMMARY_COL]);
    expect(isMirrored(next)).toBe(true);
  });

  it("行の本文を直すと共通のセルも追従する", () => {
    const next = edit(makeRow(), (e) =>
      e.onCategorySummaryChange("p-1", 1, "玄関サッシの建付け不良"),
    );
    expect(next.cells[SUMMARY_COL]).toBe("①1階洋室のクロスに凹凸\n②玄関サッシの建付け不良");
    expect(isMirrored(next)).toBe(true);
  });

  it("区分を選び直しても本文と鏡は変わらない", () => {
    const row = makeRow();
    const next = edit(row, (e) => e.onCategoryChange("p-1", 1, "玄関ドア"));
    expect(next.categories[1]).toMatchObject({
      value: "玄関ドア",
      summary: "玄関サッシの結露",
    });
    expect(next.cells[SUMMARY_COL]).toBe(row.cells[SUMMARY_COL]);
  });

  it("区分を消して1件になったら共通のセルにまとめ、本文を外す", () => {
    const next = edit(makeRow(), (e) => e.onCategoryRemove("p-1", 1));
    expect(next.categories).toHaveLength(1);
    expect(summaries(next)).toEqual([undefined]);
    expect(next.cells[SUMMARY_COL]).toBe("1階洋室のクロスに凹凸");
  });

  it("3件から1件消しても分けたまま、鏡は更新される", () => {
    const row = makeRow({
      cells: cellsWith("①A\n②B\n③C"),
      categories: [
        { value: "クロス", confidence: "ok", summary: "A" },
        { value: "サッシ", confidence: "ok", summary: "B" },
        { value: "その他", confidence: "ok", summary: "C" },
      ],
    });
    const next = edit(row, (e) => e.onCategoryRemove("p-1", 1));
    expect(summaries(next)).toEqual(["A", "C"]);
    expect(next.cells[SUMMARY_COL]).toBe("①A\n②C");
    expect(isMirrored(next)).toBe(true);
  });

  it("1件の行の区分を消しても共通のセルは書き換えない", () => {
    const row = singleRow();
    const next = edit(row, (e) => e.onCategoryRemove("p-1", 0));
    expect(next.categories).toHaveLength(0);
    expect(next.cells[SUMMARY_COL]).toBe(row.cells[SUMMARY_COL]);
  });

  it("分ける / まとめるの切り替えは持たない (工事区分の数で決まる)", () => {
    const editors = useRowEditors<ResultRow>(() => {});
    expect("onSplitSummaryChange" in editors).toBe(false);
  });
});

describe("処置も工事区分の数で分かれる (2026-09-25)", () => {
  const withTreatment = (row: ResultRow, treatment: string) => ({
    ...row,
    cells: row.cells.map((c, i) => (i === TREATMENT_COL ? treatment : c)),
  });
  /** 2件で、各行に処置があり、共通のセルはその鏡 */
  const splitRow = () =>
    makeRow({
      cells: cellsWith(MERGED).map((c, i) => (i === TREATMENT_COL ? "クロス張替え\nパッキン交換" : c)),
      categories: [
        { value: "クロス", confidence: "ok", summary: "1階洋室のクロスに凹凸", treatment: "クロス張替え" },
        { value: "サッシ", confidence: "ok", summary: "玄関サッシの結露", treatment: "パッキン交換" },
      ],
    });
  const treatments = (row: ResultRow) => row.categories.map((c: WorkCategoryEntry) => c.treatment);
  const isTreatmentMirrored = (row: ResultRow) =>
    row.cells[TREATMENT_COL] === mergeTreatments(row.categories);

  it("1件→2件に足すと、共通の処置は元の行 (先頭) に残り、足した行は空欄", () => {
    const next = edit(withTreatment(singleRow(), "クロス張替え"), (e) => e.onCategoryAdd("p-1"));
    expect(treatments(next)).toEqual(["クロス張替え", ""]);
    expect(next.cells[TREATMENT_COL]).toBe("クロス張替え");
  });

  it("2件以上のときに足した行は処置も空欄", () => {
    const next = edit(splitRow(), (e) => e.onCategoryAdd("p-1"));
    expect(treatments(next)).toEqual(["クロス張替え", "パッキン交換", ""]);
    expect(isTreatmentMirrored(next)).toBe(true);
  });

  it("行の処置を直すと、その行だけが変わり、共通のセルも追従する", () => {
    const next = edit(splitRow(), (e) => e.onCategoryTreatmentChange("p-1", 1, "建付け調整"));
    expect(treatments(next)).toEqual(["クロス張替え", "建付け調整"]);
    expect(next.cells[TREATMENT_COL]).toBe("クロス張替え\n建付け調整");
    // 点検内容は変わらない
    expect(summaries(next)).toEqual(["1階洋室のクロスに凹凸", "玄関サッシの結露"]);
    expect(next.cells[SUMMARY_COL]).toBe(MERGED);
  });

  it("行の点検内容を直しても、処置は変わらない", () => {
    const next = edit(splitRow(), (e) => e.onCategorySummaryChange("p-1", 0, "クロスの剥がれ"));
    expect(treatments(next)).toEqual(["クロス張替え", "パッキン交換"]);
    expect(isTreatmentMirrored(next)).toBe(true);
  });

  it("区分を選び直しても処置は残る", () => {
    const next = edit(splitRow(), (e) => e.onCategoryChange("p-1", 1, "玄関ドア"));
    expect(next.categories[1]).toMatchObject({ value: "玄関ドア", treatment: "パッキン交換" });
  });

  it("区分を消して1件になったら、残った行の処置を共通のセルに戻し、区分から外す", () => {
    const next = edit(splitRow(), (e) => e.onCategoryRemove("p-1", 1));
    expect(treatments(next)).toEqual([undefined]);
    expect(next.cells[TREATMENT_COL]).toBe("クロス張替え");
  });

  it("3件から1件消しても分けたまま、処置の鏡は更新される", () => {
    const next = edit(
      edit(splitRow(), (e) => e.onCategoryAdd("p-1")),
      (e) => e.onCategoryRemove("p-1", 0),
    );
    expect(treatments(next)).toEqual(["パッキン交換", ""]);
    expect(next.cells[TREATMENT_COL]).toBe("パッキン交換");
  });
});

describe("onContactsChange", () => {
  it("連絡先だけを差し替え、カナ・セルはそのまま", () => {
    const row = makeRow();
    const contact: Contact = { phone: "090-0000-1234", relation: "奥様", confidence: "ok" };
    const next = edit(row, (e) => e.onContactsChange("p-1", [contact]));
    expect(next.mail.contacts).toEqual([contact]);
    expect(next.mail.ownerKana).toBe("カクウ　タロウ");
    expect(next.cells).toBe(row.cells);
  });
});
