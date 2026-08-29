import { describe, expect, it } from "vitest";
import { blankCells, buildCells, entry } from "@/lib/cells";
import { COLUMNS, HANDOVER_COL, OWNER_COL, REMARKS_COL, SUMMARY_COL } from "@/lib/tsv";

describe("buildCells", () => {
  it("列名で指定した値が COLUMNS の位置に入り、他は空欄になる", () => {
    const { cells, confidences } = buildCells({
      お客様氏名: entry("山田　太郎"),
      引渡日: entry("2025/09/26", "warn"),
      アフター受付内容: entry("壁のひび", "fail"),
    });
    expect(cells).toHaveLength(COLUMNS.length);
    expect(confidences).toHaveLength(COLUMNS.length);
    expect(cells[OWNER_COL]).toBe("山田　太郎");
    expect(cells[HANDOVER_COL]).toBe("2025/09/26");
    expect(confidences[HANDOVER_COL]).toBe("warn");
    expect(confidences[SUMMARY_COL]).toBe("fail");
    // 指定しなかった列は空欄・ok
    expect(cells[REMARKS_COL]).toBe("");
    expect(confidences[REMARKS_COL]).toBe("ok");
  });

  it("何も指定しなければ全列が空欄", () => {
    const { cells } = buildCells({});
    expect(cells.every((c) => c === "")).toBe(true);
  });
});

describe("blankCells", () => {
  it("全列が空欄・fail になる (抽出失敗の行)", () => {
    const { cells, confidences } = blankCells();
    expect(cells).toHaveLength(COLUMNS.length);
    expect(confidences.every((c) => c === "fail")).toBe(true);
  });
});
