import { describe, expect, it } from "vitest";
import { mapTextItems } from "@/lib/pdf/tokens";
import { toHalfWidthAlnum } from "@/lib/text";

describe("toHalfWidthAlnum", () => {
  it("全角英数字を半角に変換する", () => {
    expect(toHalfWidthAlnum("ＳＥＣＵＲＥＡ架空町 Ａ号棟 ３ヶ月 ０１２ａｂｃ")).toBe(
      "SECUREA架空町 A号棟 3ヶ月 012abc",
    );
  });

  it("記号・カナ・漢字は変換しない (全角ハイフン・全角スラッシュ等は保持)", () => {
    expect(toHalfWidthAlnum("３－１５／様邸・アパート")).toBe("3－15／様邸・アパート");
  });
});

describe("mapTextItems", () => {
  it("PDFトークンの英数字が半角に正規化される", () => {
    const tokens = mapTextItems(
      [{ str: "ＳＥＣＵＲＥＡ架空町３丁目Ａ号地", transform: [1, 0, 0, 1, 100, 700] }],
      842,
      1,
    );
    expect(tokens[0].str).toBe("SECUREA架空町3丁目A号地");
  });
});
