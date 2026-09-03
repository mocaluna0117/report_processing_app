import { describe, expect, it } from "vitest";
import { NO_DEFECT_TEXT } from "@/lib/summarize/format";
import {
  distributeSummary,
  isSummarySplit,
  mergeSplitSummary,
  recordSummary,
} from "@/lib/summary";
import { COLUMNS, SUMMARY_COL } from "@/lib/tsv";

const cellsWith = (summary: string) =>
  COLUMNS.map((c, i) => (i === SUMMARY_COL ? summary : `v:${c}`));

describe("distributeSummary", () => {
  it("事象を工事区分のキーワードで振り分ける (1件だけの行は番号なし)", () => {
    const texts = distributeSummary(
      "①1階洋室天井のクロスに凹凸\n②2階サッシの結露",
      ["クロス", "サッシ"],
    );
    expect(texts).toEqual(["1階洋室天井のクロスに凹凸", "2階サッシの結露"]);
  });

  it("同じ区分に2件以上入る行は①から振り直す", () => {
    const texts = distributeSummary(
      "①1階洋室のクロスに凹凸\n②2階リビングの壁紙に浮き\n③玄関サッシの建付け不良",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("①1階洋室のクロスに凹凸\n②2階リビングの壁紙に浮き");
    expect(texts[1]).toBe("玄関サッシの建付け不良");
  });

  it("どの区分にも当たらない事象は「その他」の行へ", () => {
    const texts = distributeSummary(
      "①クロスに凹凸\n②2階階段ササラ仕上げの剥がれ",
      ["クロス", "その他"],
    );
    expect(texts[0]).toBe("クロスに凹凸");
    expect(texts[1]).toBe("2階階段ササラ仕上げの剥がれ");
  });

  it("「その他」が無ければ先頭の行へ", () => {
    const texts = distributeSummary(
      "①玄関サッシの建付け不良\n②2階階段ササラ仕上げの剥がれ",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("2階階段ササラ仕上げの剥がれ");
    expect(texts[1]).toBe("玄関サッシの建付け不良");
  });

  it("点検員メモは先頭の行にだけ付ける (事象として数えない)", () => {
    const texts = distributeSummary(
      "①クロスに凹凸\n②サッシの結露\nメモ: 次回は奥様が立ち会い",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("クロスに凹凸\nメモ: 次回は奥様が立ち会い");
    expect(texts[1]).toBe("サッシの結露");
  });

  it("「指摘なし」の定型文は先頭の行にだけ残す", () => {
    const texts = distributeSummary(NO_DEFECT_TEXT, ["クロス", "サッシ"]);
    expect(texts).toEqual([NO_DEFECT_TEXT, ""]);
  });

  it("空の本文なら全行が空欄 (戻り値の数は区分の数と同じ)", () => {
    expect(distributeSummary("", ["クロス", "サッシ", "その他"])).toEqual(["", "", ""]);
  });

  it("同じ区分が2つあれば先頭の方へ入れる", () => {
    const texts = distributeSummary("①クロスに凹凸\n②壁紙に浮き", ["クロス", "クロス"]);
    expect(texts[0]).toBe("①クロスに凹凸\n②壁紙に浮き");
    expect(texts[1]).toBe("");
  });

  it("空欄の区分はキーワード一致の対象にせず、当たらない事象だけ先頭に入る", () => {
    const texts = distributeSummary("①サッシの結露\n②原因不明の異音", ["", "サッシ"]);
    expect(texts[0]).toBe("原因不明の異音");
    expect(texts[1]).toBe("サッシの結露");
  });
});

describe("mergeSplitSummary", () => {
  it("区分の順に並べて①②③を振り直す", () => {
    const text = mergeSplitSummary([
      { summary: "①クロスに凹凸\n②壁紙に浮き" },
      { summary: "サッシの結露" },
    ]);
    expect(text).toBe("①クロスに凹凸\n②壁紙に浮き\n③サッシの結露");
  });

  it("同じメモが複数行にあっても1つにまとめて末尾に置く", () => {
    const text = mergeSplitSummary([
      { summary: "クロスに凹凸\nメモ: 奥様立ち会い" },
      { summary: "サッシの結露\nメモ: 奥様立ち会い" },
    ]);
    expect(text).toBe("①クロスに凹凸\n②サッシの結露\nメモ: 奥様立ち会い");
  });

  it("すべて空で定型文だけならその定型文に戻す", () => {
    expect(mergeSplitSummary([{ summary: NO_DEFECT_TEXT }, { summary: "" }])).toBe(NO_DEFECT_TEXT);
  });
});

describe("recordSummary", () => {
  it("分けていなければセルの値をそのまま返す", () => {
    const row = {
      cells: cellsWith("①クロスに凹凸\n②サッシの結露"),
      categories: [
        { value: "クロス", summary: "A" },
        { value: "サッシ", summary: "B" },
      ],
    };
    expect(recordSummary(row)).toBe("①クロスに凹凸\n②サッシの結露");
  });

  it("分けていれば全区分をまとめたものを返す", () => {
    const row = {
      cells: cellsWith("分ける前の本文"),
      splitSummary: true,
      categories: [
        { value: "クロス", summary: "クロスに凹凸" },
        { value: "サッシ", summary: "サッシの結露" },
      ],
    };
    expect(recordSummary(row)).toBe("①クロスに凹凸\n②サッシの結露");
  });

  it("工事区分が1件だけならセルの値を使う", () => {
    const row = {
      cells: cellsWith("共通の本文"),
      splitSummary: true,
      categories: [{ value: "クロス", summary: "クロスに凹凸" }],
    };
    expect(recordSummary(row)).toBe("共通の本文");
  });

  it("本文が無い区分は空として扱う", () => {
    const row = {
      cells: cellsWith("分ける前の本文"),
      splitSummary: true,
      categories: [{ value: "クロス", summary: "クロスに凹凸" }, { value: "サッシ" }],
    };
    expect(recordSummary(row)).toBe("クロスに凹凸");
  });
});

describe("isSummarySplit", () => {
  const cells = cellsWith("本文");
  it("フラグが立っていて工事区分が2件以上なら分割中", () => {
    expect(
      isSummarySplit({ cells, splitSummary: true, categories: [{ value: "a" }, { value: "b" }] }),
    ).toBe(true);
  });

  it("工事区分が1件以下なら分割扱いにしない", () => {
    expect(isSummarySplit({ cells, splitSummary: true, categories: [{ value: "a" }] })).toBe(false);
    expect(isSummarySplit({ cells, splitSummary: true, categories: [] })).toBe(false);
  });

  it("フラグが無ければ分割扱いにしない", () => {
    expect(isSummarySplit({ cells, categories: [{ value: "a" }, { value: "b" }] })).toBe(false);
  });
});
