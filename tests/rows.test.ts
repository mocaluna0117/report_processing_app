import { describe, expect, it } from "vitest";
import { dropColumns, expandRow } from "@/lib/rows";
import { COLUMNS, WORK_COL } from "@/lib/tsv";

const base = COLUMNS.map((c) => (c === "PJ" ? "9900110101" : c === "工事区分" ? "" : `v:${c}`));

describe("expandRow", () => {
  it("工事区分が0件なら工事区分空欄の1行", () => {
    const rows = expandRow(base, []);
    expect(rows).toHaveLength(1);
    expect(rows[0][WORK_COL]).toBe("");
    expect(rows[0]).toEqual(base);
  });

  it("工事区分の数だけ行に展開し、他の列は同じ値", () => {
    const rows = expandRow(base, ["クロス", "内部建材"]);
    expect(rows).toHaveLength(2);
    expect(rows[0][WORK_COL]).toBe("クロス");
    expect(rows[1][WORK_COL]).toBe("内部建材");
    for (const row of rows) {
      row.forEach((v, i) => {
        if (i !== WORK_COL) expect(v).toBe(base[i]);
      });
    }
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
