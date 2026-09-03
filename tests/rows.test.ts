import { describe, expect, it } from "vitest";
import { dropColumns, expandResultRow, expandRow } from "@/lib/rows";
import { COLUMNS, SUMMARY_COL, WORK_COL } from "@/lib/tsv";

const base = COLUMNS.map((c) => (c === "PJ" ? "9900110101" : c === "工事区分" ? "" : `v:${c}`));

describe("expandRow", () => {
  it("工事区分が0件なら工事区分空欄の1行", () => {
    const rows = expandRow(base, []);
    expect(rows).toHaveLength(1);
    expect(rows[0][WORK_COL]).toBe("");
    expect(rows[0]).toEqual(base);
  });

  it("工事区分の数だけ行に展開し、他の列は同じ値", () => {
    const rows = expandRow(base, [{ value: "クロス" }, { value: "内部建材" }]);
    expect(rows).toHaveLength(2);
    expect(rows[0][WORK_COL]).toBe("クロス");
    expect(rows[1][WORK_COL]).toBe("内部建材");
    for (const row of rows) {
      row.forEach((v, i) => {
        if (i !== WORK_COL) expect(v).toBe(base[i]);
      });
    }
  });

  it("summary を持つ区分は点検内容だけ差し替える", () => {
    const rows = expandRow(base, [
      { value: "クロス", summary: "①クロスに凹凸" },
      { value: "サッシ", summary: "サッシの結露" },
    ]);
    expect(rows[0][SUMMARY_COL]).toBe("①クロスに凹凸");
    expect(rows[1][SUMMARY_COL]).toBe("サッシの結露");
    for (const row of rows) {
      row.forEach((v, i) => {
        if (i !== WORK_COL && i !== SUMMARY_COL) expect(v).toBe(base[i]);
      });
    }
  });

  it("summary が無い区分は共通のセルを使い、空文字は空欄として扱う", () => {
    const cells = base.map((v, i) => (i === SUMMARY_COL ? "共通の点検内容" : v));
    const rows = expandRow(cells, [{ value: "クロス" }, { value: "サッシ", summary: "" }]);
    expect(rows[0][SUMMARY_COL]).toBe("共通の点検内容");
    expect(rows[1][SUMMARY_COL]).toBe("");
  });
});

describe("expandResultRow", () => {
  const resultRow = (
    categories: { value: string; summary?: string }[],
    splitSummary?: boolean,
  ) => ({
    cells: base.map((v, i) => (i === SUMMARY_COL ? "共通の点検内容" : v)),
    categories,
    splitSummary,
  });

  it("分けていなければ全行に共通の点検内容が入る", () => {
    const rows = expandResultRow(
      resultRow([{ value: "クロス", summary: "A" }, { value: "サッシ", summary: "B" }]),
    );
    expect(rows.map((r) => r[SUMMARY_COL])).toEqual(["共通の点検内容", "共通の点検内容"]);
  });

  it("分けていれば区分ごとの点検内容が入る", () => {
    const rows = expandResultRow(
      resultRow([{ value: "クロス", summary: "A" }, { value: "サッシ", summary: "B" }], true),
    );
    expect(rows.map((r) => r[SUMMARY_COL])).toEqual(["A", "B"]);
  });

  it("工事区分が1件だけなら分割扱いにしない", () => {
    const rows = expandResultRow(resultRow([{ value: "クロス", summary: "A" }], true));
    expect(rows.map((r) => r[SUMMARY_COL])).toEqual(["共通の点検内容"]);
  });

  it("分割中に本文が無い区分は空欄になる", () => {
    const rows = expandResultRow(
      resultRow([{ value: "クロス", summary: "A" }, { value: "サッシ" }], true),
    );
    expect(rows.map((r) => r[SUMMARY_COL])).toEqual(["A", ""]);
  });
});

describe("dropColumns", () => {
  it("指定した列を落とす (アフターの備考欄)", () => {
    const rows = [["a", "b", "c"], ["d", "e", "f"]];
    expect(dropColumns(rows, new Set([2]))).toEqual([["a", "b"], ["d", "e"]]);
  });

  it("空の指定なら元の配列をそのまま返す", () => {
    const rows = [["a", "b"]];
    expect(dropColumns(rows, new Set())).toBe(rows);
  });
});
