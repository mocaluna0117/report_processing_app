import { describe, expect, it } from "vitest";
import { hiraganaToKatakana, normalizeKana, normalizeNameReading } from "@/lib/kana";

describe("hiraganaToKatakana", () => {
  it("ひらがなをカタカナにする (カタカナ・記号はそのまま)", () => {
    expect(hiraganaToKatakana("やまだ　たろう")).toBe("ヤマダ　タロウ");
    expect(hiraganaToKatakana("ヤマダ　タロウ")).toBe("ヤマダ　タロウ");
  });
});

describe("normalizeKana", () => {
  it("空白を全角1つに揃え、前後の空白を落とす", () => {
    expect(normalizeKana(" ヤマダ タロウ ")).toEqual({ kana: "ヤマダ　タロウ", valid: true });
    expect(normalizeKana("ヤマダ　　タロウ")).toEqual({ kana: "ヤマダ　タロウ", valid: true });
  });

  it("ひらがなで返ってきてもカタカナにする", () => {
    expect(normalizeKana("やまだ たろう")).toEqual({ kana: "ヤマダ　タロウ", valid: true });
  });

  it("長音・小書き文字を含むカタカナは有効", () => {
    expect(normalizeKana("チョウ　イカク").valid).toBe(true);
    expect(normalizeKana("サトウ　リョウ").valid).toBe(true);
  });

  it("漢字や英字が混ざれば無効", () => {
    expect(normalizeKana("山田　タロウ").valid).toBe(false);
    expect(normalizeKana("").valid).toBe(false);
  });
});

describe("normalizeNameReading", () => {
  it("高信頼の読みはそのまま", () => {
    expect(
      normalizeNameReading({ kana: "ヤマダ　タロウ", alternatives: [], confidence: "high" }),
    ).toEqual({ kana: "ヤマダ　タロウ", alternatives: [], confidence: "high" });
  });

  it("候補があれば low に落とし、重複と本命と同じものは除く", () => {
    expect(
      normalizeNameReading({
        kana: "タカハシ　ヨシコ",
        alternatives: ["タカハシ　カコ", "タカハシ　ヨシコ", "たかはし けいこ", "タカハシ　カコ"],
        confidence: "high",
      }),
    ).toEqual({
      kana: "タカハシ　ヨシコ",
      alternatives: ["タカハシ　カコ", "タカハシ　ケイコ"],
      confidence: "low",
    });
  });

  it("カタカナ以外が混ざる読みは low", () => {
    expect(normalizeNameReading({ kana: "山田 タロウ", alternatives: [], confidence: "high" }).confidence).toBe("low");
  });

  it("形が壊れていても落ちない", () => {
    expect(normalizeNameReading({})).toEqual({ kana: "", alternatives: [], confidence: "low" });
    expect(normalizeNameReading({ kana: 123, alternatives: "x", confidence: null })).toEqual({
      kana: "",
      alternatives: [],
      confidence: "low",
    });
  });
});
