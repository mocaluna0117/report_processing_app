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
