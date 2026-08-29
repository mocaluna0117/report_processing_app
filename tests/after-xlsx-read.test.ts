import { describe, expect, it } from "vitest";
import { columnIndex, isZip, readXlsxSheets, XlsxReadError } from "@/lib/after/xlsx-read";
import { buildXlsx } from "./helpers/xlsx-fixture";

describe("readXlsxSheets", () => {
  it("共有文字列のシートを読む (助っ人クラウド形式)", () => {
    const bytes = buildXlsx([
      {
        name: "住宅情報登録用シート",
        rows: [
          ["※必須\n施主名（姓）", "管理ID"],
          ["山田　", "1234-5"],
        ],
      },
    ]);
    const sheets = readXlsxSheets(bytes);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("住宅情報登録用シート");
    expect(sheets[0].rows[0]).toEqual(["※必須\n施主名（姓）", "管理ID"]);
    expect(sheets[0].rows[1]).toEqual(["山田　", "1234-5"]);
  });

  it("インライン文字列のシートを読む (DX形式)", () => {
    const bytes = buildXlsx(
      [{ name: "Sheet1", rows: [["物件番号", "居住者名"], ["2101230101", "架空　花子"]] }],
      { mode: "inline" },
    );
    expect(readXlsxSheets(bytes)[0].rows[1]).toEqual(["2101230101", "架空　花子"]);
  });

  it("ふりがな (rPh) は値に混ぜない", () => {
    const bytes = buildXlsx([{ name: "S", rows: [["架空町"], ["x"]] }], { withRuby: true });
    expect(readXlsxSheets(bytes)[0].rows[0][0]).toBe("架空町");
  });

  it("XMLエスケープを元に戻す", () => {
    const bytes = buildXlsx([{ name: "S", rows: [["A&B <C>"]] }]);
    expect(readXlsxSheets(bytes)[0].rows[0][0]).toBe("A&B <C>");
  });

  it("空セルは空文字で埋め、行の列数を揃える", () => {
    const bytes = buildXlsx([{ name: "S", rows: [["a", "", "c"], ["d"]] }]);
    const rows = readXlsxSheets(bytes)[0].rows;
    expect(rows[0]).toEqual(["a", "", "c"]);
    expect(rows[1]).toEqual(["d", "", ""]);
  });

  it("数値セルは文字列として返す", () => {
    const bytes = buildXlsx([{ name: "S", rows: [["n"], [2101230101]] }]);
    expect(readXlsxSheets(bytes)[0].rows[1][0]).toBe("2101230101");
  });

  it("シートのパートが連番でなくても rels から解決する", () => {
    const bytes = buildXlsx([{ name: "後ろのシート", rows: [["v"]] }], {
      sheetPaths: ["xl/worksheets/sheet7.xml"],
    });
    expect(readXlsxSheets(bytes)[0].rows[0][0]).toBe("v");
  });

  it("複数シートを順に返す", () => {
    const bytes = buildXlsx([
      { name: "一枚目", rows: [["a"]] },
      { name: "二枚目", rows: [["b"]] },
    ]);
    expect(readXlsxSheets(bytes).map((s) => s.name)).toEqual(["一枚目", "二枚目"]);
  });

  it("xlsx でなければエラー", () => {
    expect(() => readXlsxSheets(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(XlsxReadError);
  });

  it("古い .xls は案内付きでエラー", () => {
    const xls = new Uint8Array(16);
    xls.set([0xd0, 0xcf, 0x11, 0xe0]);
    expect(() => readXlsxSheets(xls)).toThrow(/\.xlsx/);
  });
});

describe("isZip / columnIndex", () => {
  it("ZIP判定", () => {
    expect(isZip(buildXlsx([{ name: "S", rows: [["a"]] }]))).toBe(true);
    expect(isZip(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("列参照を0始まりの番号にする", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("B3")).toBe(1);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnIndex("AW2")).toBe(48);
  });
});
