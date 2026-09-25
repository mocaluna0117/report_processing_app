import { describe, expect, it } from "vitest";
import { circledNumber, formatPhenomena } from "@/lib/summarize/format";

describe("circledNumber", () => {
  it("1〜20は丸数字", () => {
    expect(circledNumber(1)).toBe("①");
    expect(circledNumber(3)).toBe("③");
    expect(circledNumber(20)).toBe("⑳");
  });

  it("21以降は括弧付き数字にフォールバック", () => {
    expect(circledNumber(21)).toBe("(21)");
  });
});

describe("formatPhenomena", () => {
  it("複数の事象は①②③付きで1行ずつ", () => {
    expect(formatPhenomena(["事象A", "事象B"])).toBe("①事象A\n②事象B");
  });

  it("1件なら番号なし", () => {
    expect(formatPhenomena(["事象A"])).toBe("事象A");
  });

  it("0件なら指摘なしの定型文", () => {
    expect(formatPhenomena([])).toBe("点検の結果、不具合の指摘なし。");
  });

  it("各要素の末尾の句点・空白は落とす", () => {
    expect(formatPhenomena(["事象A。 ", " 事象B。"])).toBe("①事象A\n②事象B");
  });

  it("空要素は無視する", () => {
    expect(formatPhenomena(["事象A", "", "  "])).toBe("事象A");
  });

  it("メモは番号なしで末尾に付く", () => {
    expect(formatPhenomena(["事象A", "事象B"], ["立ち会いは管理者様"])).toBe(
      "①事象A\n②事象B\nメモ: 立ち会いは管理者様",
    );
  });

  it("事象が0件でもメモは残す", () => {
    expect(formatPhenomena([], ["立ち会いは管理者様"])).toBe(
      "点検の結果、不具合の指摘なし。\nメモ: 立ち会いは管理者様",
    );
  });
});

describe("formatPhenomena (補足)", () => {
  it("補足は事象の次の行に「補足: 」で入る", () => {
    expect(formatPhenomena(["事象A", "事象B"], [], { supplements: [["通気の清掃も必要"], []] })).toBe(
      "①事象A\n補足: 通気の清掃も必要\n②事象B",
    );
  });

  it("1件だけ (番号なし) でも補足は次の行に入る", () => {
    expect(formatPhenomena(["事象A"], [], { supplements: [["写真3枚目"]] })).toBe(
      "事象A\n補足: 写真3枚目",
    );
  });

  it("★空の事象は補足ごと落とす (番号と補足がずれないように)", () => {
    expect(
      formatPhenomena(["", "事象B"], [], { supplements: [["消える補足"], ["残る補足"]] }),
    ).toBe("事象B\n補足: 残る補足");
  });

  it("★1つの事象に補足をいくつでも付けられる（1つにつき「補足: 」の行が1行。2026-09-25）", () => {
    expect(formatPhenomena(["事象A", "事象B"], [], { supplements: [["土台水切りの隙間", "通気パッキンの清掃"], ["部品を手配"]] })).toBe(
      "①事象A\n補足: 土台水切りの隙間\n補足: 通気パッキンの清掃\n②事象B\n補足: 部品を手配",
    );
  });

  it("★空の補足は書かない。先頭に打った「・」は落とす（報告書で「・・」にならないように）", () => {
    expect(formatPhenomena(["事象A"], [], { supplements: [["", "  ", "・床鳴り", "･ 半角の点"]] })).toBe(
      "事象A\n補足: 床鳴り\n補足: 半角の点",
    );
  });

  it("メモは補足のあとに、今までどおり末尾へ付く", () => {
    expect(formatPhenomena(["事象A"], ["奥様が立ち会い"], { supplements: [["補足あり"]] })).toBe(
      "事象A\n補足: 補足あり\nメモ: 奥様が立ち会い",
    );
  });
});
