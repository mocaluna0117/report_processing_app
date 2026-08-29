import { describe, expect, it } from "vitest";
import { mapTextItems } from "@/lib/pdf/tokens";
import {
  toDateNoPad,
  toDateZeroPad,
  toFullWidthKatakana,
  toFullWidthSpace,
  toHalfWidthAlnum,
  trimWide,
} from "@/lib/text";

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

describe("toDateNoPad", () => {
  it("YYYY/MM/DD をゼロ埋めなしの yyyy/m/d にする", () => {
    expect(toDateNoPad("2026/07/22")).toBe("2026/7/22");
    expect(toDateNoPad("2026/11/05")).toBe("2026/11/5");
  });

  it("日付形式でなければそのまま返す", () => {
    expect(toDateNoPad("")).toBe("");
    expect(toDateNoPad("不明")).toBe("不明");
  });
});

describe("toDateZeroPad", () => {
  it("yyyy/m/d をゼロ埋めの yyyy/mm/dd にする (メール文用)", () => {
    expect(toDateZeroPad("2025/9/26")).toBe("2025/09/26");
    expect(toDateZeroPad("2026/4/5")).toBe("2026/04/05");
    expect(toDateZeroPad("2026/11/25")).toBe("2026/11/25");
  });

  it("日付形式でなければそのまま返す", () => {
    expect(toDateZeroPad("")).toBe("");
    expect(toDateZeroPad("不明")).toBe("不明");
  });
});

describe("toFullWidthSpace", () => {
  it("姓名の区切りを全角スペースにする", () => {
    expect(toFullWidthSpace("山田 太郎")).toBe("山田　太郎");
    expect(toFullWidthSpace("佐々木 花子")).toBe("佐々木　花子");
  });

  it("連続した空白も1つの全角スペースにまとめる", () => {
    expect(toFullWidthSpace("山田   太郎")).toBe("山田　太郎");
  });

  it("空白が無い場合・空文字はそのまま", () => {
    expect(toFullWidthSpace("山田")).toBe("山田");
    expect(toFullWidthSpace("")).toBe("");
  });

  it("既に全角スペースの場合は変えない", () => {
    expect(toFullWidthSpace("山田　太郎")).toBe("山田　太郎");
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

describe("toFullWidthKatakana", () => {
  it("半角カナを全角にする (濁点も合成)", () => {
    expect(toFullWidthKatakana("ｾｷｭﾚｱ")).toBe("セキュレア");
    expect(toFullWidthKatakana("ﾋﾞﾙ")).toBe("ビル");
  });

  it("丸数字・漢字・全角英数はそのまま", () => {
    expect(toFullWidthKatakana("①セキュレア文京")).toBe("①セキュレア文京");
  });
});

describe("trimWide", () => {
  it("前後の全角スペース・タブ・改行を落とす", () => {
    expect(trimWide("　山田　太郎　")).toBe("山田　太郎");
    expect(trimWide("\t架空台1丁目 \n")).toBe("架空台1丁目");
  });

  it("内部の空白は残す", () => {
    expect(trimWide(" A B ")).toBe("A B");
  });
});
