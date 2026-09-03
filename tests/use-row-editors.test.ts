import { describe, expect, it } from "vitest";
import type { ResultRow } from "@/lib/process";
import { DEFAULT_REPORT_OPTIONS } from "@/lib/report/model";
import { COLUMNS, SUMMARY_COL } from "@/lib/tsv";
import type { WorkCategoryEntry } from "@/lib/types";
import { useRowEditors } from "@/lib/use-row-editors";

// useRowEditors は React のフックを使わない (更新関数を受け取るだけ) ので、そのまま呼んで確かめる
const makeRow = (over: Partial<ResultRow> = {}): ResultRow => ({
  pairId: "p-1",
  ownerDisplay: "架空 太郎",
  cells: COLUMNS.map((c, i) =>
    i === SUMMARY_COL ? "①1階洋室のクロスに凹凸\n②玄関サッシの結露" : `v:${c}`,
  ),
  confidences: COLUMNS.map(() => "ok" as const),
  categories: [
    { value: "クロス", confidence: "ok" },
    { value: "サッシ", confidence: "ok" },
  ],
  categoryEngine: "gemini",
  report: DEFAULT_REPORT_OPTIONS,
  mail: { ownerKana: "", kanaConfidence: "fail", kanaAlternatives: [], contacts: [] },
  warnings: [],
  engine: "gemini",
  merged: null,
  mergedName: "",
  error: null,
  ...over,
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

describe("点検内容を工事区分ごとに分ける", () => {
  it("分けると本文がキーワードで振り分けられる", () => {
    const next = edit(makeRow(), (e) => e.onSplitSummaryChange("p-1", true));
    expect(next.splitSummary).toBe(true);
    expect(summaries(next)).toEqual(["1階洋室のクロスに凹凸", "玄関サッシの結露"]);
    // 分ける前の本文はセルに残す
    expect(next.cells[SUMMARY_COL]).toBe("①1階洋室のクロスに凹凸\n②玄関サッシの結露");
  });

  it("工事区分が1件だけなら分けない", () => {
    const row = makeRow({ categories: [{ value: "クロス", confidence: "ok" }] });
    expect(edit(row, (e) => e.onSplitSummaryChange("p-1", true))).toBe(row);
  });

  it("まとめると各行の内容が共通のセルに戻る (分けて直した分も残る)", () => {
    const split = edit(makeRow(), (e) => e.onSplitSummaryChange("p-1", true));
    const edited = edit(split, (e) => e.onCategorySummaryChange("p-1", 1, "玄関サッシの建付け不良"));
    const merged = edit(edited, (e) => e.onSplitSummaryChange("p-1", false));
    expect(merged.splitSummary).toBe(false);
    expect(merged.cells[SUMMARY_COL]).toBe("①1階洋室のクロスに凹凸\n②玄関サッシの建付け不良");
    expect(summaries(merged)).toEqual([undefined, undefined]);
  });

  it("区分を選び直しても、その行に書いた本文は残る", () => {
    const split = edit(makeRow(), (e) => e.onSplitSummaryChange("p-1", true));
    const changed = edit(split, (e) => e.onCategoryChange("p-1", 1, "玄関ドア"));
    expect(changed.categories[1]).toMatchObject({
      value: "玄関ドア",
      summary: "玄関サッシの結露",
    });
  });

  it("分けている最中に足した行は本文が空欄から始まる", () => {
    const split = edit(makeRow(), (e) => e.onSplitSummaryChange("p-1", true));
    const added = edit(split, (e) => e.onCategoryAdd("p-1"));
    expect(added.categories).toHaveLength(3);
    expect(added.categories[2]).toMatchObject({ value: "", summary: "" });
  });

  it("分けていないときに足した行は本文を持たない", () => {
    const added = edit(makeRow(), (e) => e.onCategoryAdd("p-1"));
    expect(added.categories[2]?.summary).toBeUndefined();
  });

  it("区分を消して1件になったら自動でまとめる (消した行の本文は落とす)", () => {
    const split = edit(makeRow(), (e) => e.onSplitSummaryChange("p-1", true));
    const removed = edit(split, (e) => e.onCategoryRemove("p-1", 1));
    expect(removed.splitSummary).toBe(false);
    expect(removed.categories).toHaveLength(1);
    expect(removed.cells[SUMMARY_COL]).toBe("1階洋室のクロスに凹凸");
  });

  it("分けていない行の区分を消しても共通のセルは書き換えない", () => {
    const row = makeRow();
    const removed = edit(row, (e) => e.onCategoryRemove("p-1", 1));
    expect(removed.cells[SUMMARY_COL]).toBe(row.cells[SUMMARY_COL]);
    expect(removed.categories).toHaveLength(1);
  });

  it("フラグだけ残った行 (工事区分1件) をまとめても本文を消さない", () => {
    const row = makeRow({
      categories: [{ value: "クロス", confidence: "ok" }],
      splitSummary: true,
    });
    const merged = edit(row, (e) => e.onSplitSummaryChange("p-1", false));
    expect(merged.cells[SUMMARY_COL]).toBe(row.cells[SUMMARY_COL]);
    expect(merged.splitSummary).toBe(false);
  });
});
