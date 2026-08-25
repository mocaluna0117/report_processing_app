import { describe, expect, it } from "vitest";
import { redactPii } from "@/lib/summarize/redact";
import { ruleBasedSummary } from "@/lib/summarize/rule-based";

describe("ruleBasedSummary", () => {
  it("不具合ゼロは定型文", () => {
    expect(
      ruleBasedSummary({
        defects: [],
        standaloneNotes: [],
        specialNotes: [],
        noAbnormality: true,
      }),
    ).toBe("点検の結果、不具合の指摘なし。");
  });

  it("不具合を「場所 部位の症状（事後対応）」で列挙する", () => {
    const s = ruleBasedSummary({
      defects: [
        {
          location: "1階 洋室",
          part: "クロス 壁",
          symptom: "のり汚れ",
          followup: "弊社継続対応",
          remarks: "継ぎ目ののり汚れ。補修をご希望です。",
        },
        {
          location: "1階 洋室",
          part: "サッシ FIX窓",
          symptom: "その他（備考）",
          followup: "見積もり希望",
          remarks: "天窓に電動のブラインドを取り付けたいとのことで見積をご希望です。",
        },
      ],
      standaloneNotes: [],
      specialNotes: [],
      noAbnormality: false,
    });
    expect(s).toContain("1階 洋室 クロス 壁ののり汚れ（弊社継続対応）");
    // 症状「その他（備考）」は備考の先頭文で置き換える
    expect(s).toContain("天窓に電動のブラインドを取り付けたいとのことで見積をご希望です（見積もり希望）");
  });

  it("特記事項とメモも含める", () => {
    const s = ruleBasedSummary({
      defects: [],
      standaloneNotes: ["サイン、立ち会い、番号は管理者様になります。"],
      specialNotes: ["クローゼットのポール外れの是正ご希望です。"],
      noAbnormality: true,
    });
    expect(s).toContain("特記事項: クローゼットのポール外れ");
    expect(s).toContain("メモ: サイン、立ち会い");
  });
});

describe("redactPii", () => {
  it("氏名・住所・電話番号を伏字化する", () => {
    const out = redactPii(
      "高橋様より東京都杉並区高円寺北1-2-3の件で090-0000-1234へ連絡。",
    );
    expect(out).not.toContain("高橋");
    expect(out).not.toContain("高円寺");
    expect(out).not.toContain("090-0000-1234");
    expect(out).toContain("お客様");
    expect(out).toContain("（住所）");
    expect(out).toContain("（電話番号）");
  });

  it("「同様」「様子」「仕様」「多様」などの一般語を壊さない (実データの備考文)", () => {
    const src =
      "以前に同様の事象にて貴社に対応を頂くも同様の事象が発生しており、調整対応をご要望です。";
    expect(redactPii(src)).toBe(src);
    const src2 = "経過観察の様子を見ることとし、仕様書の通り多様なケースに対応。";
    expect(redactPii(src2)).toBe(src2);
  });

  it("「管理者様」などの役割語を壊さない (実データのメモ文)", () => {
    const src = "サイン、立ち会い、番号は管理者様になります。";
    expect(redactPii(src)).toBe(src);
  });

  it("ハイフン無し電話番号・メール・都道府県なし住所・「さん」敬称も伏字化する", () => {
    const out = redactPii(
      "田中さんが確認。09000001234またはtaro@example.comへ。杉並区高円寺北1-2-3在住。",
    );
    expect(out).not.toContain("田中");
    expect(out).not.toContain("09000001234");
    expect(out).not.toContain("taro@example.com");
    expect(out).not.toContain("高円寺");
  });

  it("本文中の数字やスペースを破壊しない", () => {
    const src = "幅 3 cm程度の隙間が 2 箇所。";
    expect(redactPii(src)).toBe(src);
  });
});
