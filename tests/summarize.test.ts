import { describe, expect, it } from "vitest";
import { redactPii } from "@/lib/summarize/redact";
import { stripRequests } from "@/lib/summarize/rule-based";
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

  it("不具合の事象のみを列挙し、要望・対応方針は含めない", () => {
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
          location: "外回り アプローチ",
          part: "タイル 床",
          symptom: "その他（備考）",
          followup: "弊社継続対応",
          remarks:
            "玄関前のタイル部に水たまりができると仰せ。勾配が取れていないのか踏むと跳ねる程度には溜まるため無償での補修をご希望。",
        },
      ],
      standaloneNotes: [],
      specialNotes: [],
      noAbnormality: false,
    });
    expect(s).toContain("1階 洋室 クロス 壁ののり汚れ");
    // 要望・対応方針の語が混ざらない
    for (const ng of ["希望", "要望", "無償", "継続対応", "見積"]) {
      expect(s, `「${ng}」が含まれている: ${s}`).not.toContain(ng);
    }
  });

  it("症状が「その他（備考）」なら備考から事象部分だけを拾う", () => {
    const s = ruleBasedSummary({
      defects: [
        {
          location: "1階 洋室",
          part: "サッシ FIX窓",
          symptom: "その他（備考）",
          followup: "見積もり希望",
          remarks:
            "天窓に電動のブラインドを取り付けたいとのことで見積をご希望です。高所のため品番写真なし。",
        },
      ],
      standaloneNotes: [],
      specialNotes: [],
      noAbnormality: false,
    });
    expect(s).not.toContain("希望");
    expect(s).not.toContain("取り付けたい");
  });

  it("特記事項とメモも事象のみに絞って含める", () => {
    const s = ruleBasedSummary({
      defects: [],
      standaloneNotes: ["サイン、立ち会い、番号は管理者様になります。"],
      specialNotes: [
        "洗面横のクローゼットのポールが外れてしまった。以前補修頂いたがネジが短い。是正ご希望です。",
      ],
      noAbnormality: true,
    });
    expect(s).toContain("特記事項:");
    expect(s).toContain("クローゼットのポールが外れ");
    expect(s).not.toContain("ご希望");
  });
});

describe("stripRequests", () => {
  it("要望・対応方針の節を落として事象だけ残す", () => {
    expect(
      stripRequests("継ぎ目ののり汚れが発生。補修をご希望です。対応可否は貴社にてご確認ください。"),
    ).toBe("継ぎ目ののり汚れが発生");
  });

  it("報告表現の語尾を削る", () => {
    expect(stripRequests("玄関前のタイル部に水たまりができると仰せ。")).toBe(
      "玄関前のタイル部に水たまりができる",
    );
    expect(stripRequests("ポールが外れてしまったとのことでございます。")).toBe(
      "ポールが外れてしまった",
    );
  });

  it("読点で区切られた列挙は読点のまま残す", () => {
    expect(stripRequests("サイン、立ち会い、番号は管理者様になります。")).toBe(
      "サイン、立ち会い、番号は管理者様になります",
    );
  });

  it("宙ぶらりんの接続語尾を削る", () => {
    expect(stripRequests("南向きで日差しが強いため、")).toBe("南向きで日差しが強い");
  });
});

describe("要望だけの項目", () => {
  it("事象が無い項目 (取付要望のみ) は要約に載せない", () => {
    const s = ruleBasedSummary({
      defects: [
        {
          location: "2階 リビング",
          part: "インテリア カーテン",
          symptom: "その他（備考）",
          followup: "見積もり希望",
          remarks:
            "2階リビング窓に電動ロールスクリーンを取付要望。南向きで日差しが強いため、提案とお見積ご要望です。",
        },
        {
          location: "2階 階段",
          part: "大工 階段",
          symptom: "はがれ",
          followup: "弊社継続対応",
          remarks: "ササラ仕上げ剥がれ。",
        },
      ],
      standaloneNotes: [],
      specialNotes: [],
      noAbnormality: false,
    });
    expect(s).toBe("2階 階段 大工 階段のはがれ。");
  });

  it("全項目が要望だけなら「不具合の指摘なし」になる", () => {
    const s = ruleBasedSummary({
      defects: [
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
    expect(s).toBe("点検の結果、不具合の指摘なし。");
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
