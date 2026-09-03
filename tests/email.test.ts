import { describe, expect, it } from "vitest";
import { buildMailText } from "@/lib/email";

const base = {
  handoverDate: "2025/9/26",
  propertyName: "999.杉並区高円寺北1-2-4A号棟",
  ownerName: "山田　太郎",
  ownerKana: "ヤマダ　タロウ",
  address: "東京都杉並区高円寺北1-2-3",
  contacts: [{ phone: "090-0000-1234", relation: "ご主人", confidence: "ok" as const }],
  summary: "①1階洋室天井のクロスに凹凸\n②2階リビング壁のクロスに浮き",
};

describe("buildMailText", () => {
  it("指定の形式で組み立てる (連絡先1件は続柄なし)", () => {
    expect(buildMailText(base)).toBe(
      [
        "【物件情報】",
        "引渡日：2025/09/26",
        "物件名：999.杉並区高円寺北1-2-4A号棟",
        "施主名：山田　太郎（ヤマダ　タロウ）様",
        "住所：東京都杉並区高円寺北1-2-3",
        "連絡先：090-0000-1234",
        "",
        "【依頼内容】",
        "①1階洋室天井のクロスに凹凸",
        "②2階リビング壁のクロスに浮き",
      ].join("\n"),
    );
  });

  it("引渡日はゼロ埋めする (Excel列はゼロ埋めなしのまま渡される)", () => {
    expect(buildMailText({ ...base, handoverDate: "2026/4/5" })).toContain("引渡日：2026/04/05");
  });

  it("連絡先が2件以上なら①②と続柄付き", () => {
    const text = buildMailText({
      ...base,
      contacts: [
        { phone: "090-0000-1234", relation: "ご主人", confidence: "ok" },
        { phone: "080-1111-2222", relation: "奥様", confidence: "ok" },
      ],
    });
    expect(text).toContain("連絡先①：090-0000-1234（ご主人）\n連絡先②：080-1111-2222（奥様）");
    expect(text).not.toContain("\n連絡先：");
  });

  it("2件以上で続柄が空なら括弧を省く", () => {
    const text = buildMailText({
      ...base,
      contacts: [
        { phone: "090-0000-1234", relation: "ご主人", confidence: "ok" },
        { phone: "080-1111-2222", relation: "", confidence: "ok" },
      ],
    });
    expect(text).toContain("連絡先②：080-1111-2222\n");
  });

  it("①を空欄にして②だけ残したら、空の行を出さず1件として書く", () => {
    const text = buildMailText({
      ...base,
      contacts: [
        { phone: "", relation: "", confidence: "ok" },
        { phone: "080-1111-2222", relation: "奥様", confidence: "ok" },
      ],
    });
    expect(text).toContain("\n連絡先：080-1111-2222\n");
    expect(text).not.toContain("連絡先①");
  });

  it("連絡先が無ければ空欄の行を残す", () => {
    expect(buildMailText({ ...base, contacts: [] })).toContain("\n連絡先：\n");
  });

  it("カナが空なら括弧ごと省く", () => {
    expect(buildMailText({ ...base, ownerKana: "" })).toContain("施主名：山田　太郎様");
  });

  it("氏名・カナの半角スペースは全角に揃える", () => {
    const text = buildMailText({ ...base, ownerName: "山田 太郎", ownerKana: "ヤマダ タロウ" });
    expect(text).toContain("施主名：山田　太郎（ヤマダ　タロウ）様");
  });

  it("施主名が無ければ「様」も付けない", () => {
    expect(buildMailText({ ...base, ownerName: "", ownerKana: "" })).toContain("施主名：\n");
  });
});
