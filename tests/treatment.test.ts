import { describe, expect, it } from "vitest";
import {
  attachTreatments,
  mergeTreatments,
  syncTreatmentCell,
  withoutTreatments,
} from "@/lib/treatment";
import { COLUMNS, TREATMENT_COL } from "@/lib/tsv";

/** 区分1件分 (テストで使う形) */
type Cat = { value: string; summary?: string; treatment?: string };

const cellsWith = (treatment: string) =>
  COLUMNS.map((c, i) => (i === TREATMENT_COL ? treatment : `v:${c}`));

describe("mergeTreatments", () => {
  it("空の行は飛ばし、区分の順に改行でつなぐ", () => {
    expect(
      mergeTreatments([{ treatment: "クロス張替え" }, { treatment: "  " }, {}, { treatment: "パッキン交換\n" }]),
    ).toBe("クロス張替え\nパッキン交換");
  });

  it("どの行も空なら空欄", () => {
    expect(mergeTreatments([{ treatment: "" }, {}])).toBe("");
  });
});

describe("withoutTreatments", () => {
  it("処置だけを外し、ほかの値は残す", () => {
    expect(withoutTreatments([{ value: "クロス", summary: "A", treatment: "B" }])).toEqual([
      { value: "クロス", summary: "A" },
    ]);
  });
});

describe("syncTreatmentCell", () => {
  it("2件以上なら共通のセルを各行の処置の鏡にする", () => {
    const next = syncTreatmentCell(cellsWith("古い処置"), [{ treatment: "A" }, { treatment: "B" }]);
    expect(next[TREATMENT_COL]).toBe("A\nB");
    next.forEach((v, i) => {
      if (i !== TREATMENT_COL) expect(v).toBe(`v:${COLUMNS[i]}`);
    });
  });

  it("鏡が揃っていれば同じ配列を返す", () => {
    const cells = cellsWith("A\nB");
    expect(syncTreatmentCell(cells, [{ treatment: "A" }, { treatment: "B" }])).toBe(cells);
  });

  it("1件以下なら触らない", () => {
    const cells = cellsWith("共通の処置");
    expect(syncTreatmentCell(cells, [{ treatment: "別の処置" }])).toBe(cells);
  });
});

describe("attachTreatments", () => {
  it("どの区分も処置を持っていなければ、共通の処置を先頭の行に入れ、ほかの行は空欄にする", () => {
    const { cells, categories } = attachTreatments<Cat>(cellsWith("クロス張替え"), [
      { value: "クロス" },
      { value: "サッシ" },
      { value: "その他" },
    ]);
    expect(categories.map((c) => c.treatment)).toEqual(["クロス張替え", "", ""]);
    expect(cells[TREATMENT_COL]).toBe("クロス張替え");
  });

  it("共通の処置が空なら全行が空欄", () => {
    const { categories } = attachTreatments<Cat>(cellsWith(""), [{ value: "クロス" }, { value: "サッシ" }]);
    expect(categories.map((c) => c.treatment)).toEqual(["", ""]);
  });

  it("一部の区分だけ持っていないときは、その区分を空欄にする (鏡を配り直して二重にしない)", () => {
    const { cells, categories } = attachTreatments<Cat>(cellsWith("A"), [
      { value: "クロス", treatment: "A" },
      { value: "サッシ" },
    ]);
    expect(categories.map((c) => c.treatment)).toEqual(["A", ""]);
    expect(cells[TREATMENT_COL]).toBe("A");
  });

  it("持っている処置は変えず、共通のセルを鏡に揃える", () => {
    const { cells, categories } = attachTreatments<Cat>(cellsWith("古い処置"), [
      { value: "クロス", treatment: "A" },
      { value: "サッシ", treatment: "B" },
    ]);
    expect(categories.map((c) => c.treatment)).toEqual(["A", "B"]);
    expect(cells[TREATMENT_COL]).toBe("A\nB");
  });

  it("1件以下なら区分から処置を外し、共通のセルは触らない", () => {
    const before = cellsWith("共通の処置");
    const { cells, categories } = attachTreatments<Cat>(before, [{ value: "クロス", treatment: "古い処置" }]);
    expect(categories).toEqual([{ value: "クロス" }]);
    expect(cells).toBe(before);
  });

  it("何度通しても同じ結果 (冪等)", () => {
    const once = attachTreatments<Cat>(cellsWith("クロス張替え\n"), [{ value: "クロス" }, { value: "サッシ" }]);
    const twice = attachTreatments<Cat>(once.cells, once.categories);
    expect(twice).toEqual(once);
    expect(twice.cells).toBe(once.cells);
  });
});
