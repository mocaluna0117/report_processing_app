import { describe, expect, it } from "vitest";
import { redactCustomer } from "@/lib/after/summarize-inquiry";
import type { Customer, CustomerFields } from "@/lib/after/types";
import { NO_DEFECT_TEXT } from "@/lib/summarize/format";
import { INQUIRY_TEXT_MAX, buildInquiryPrompt, ruleBasedInquirySummary } from "@/lib/summarize/inquiry";

const fields: CustomerFields = {
  pj: "2101230101",
  developer: "タカマツハウス",
  propertyName: "架空台1丁目 A号棟",
  ownerName: "山田　太郎",
  ownerKana: "ヤマダ　タロウ",
  address: "東京都架空区北町1-2-3",
  contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
  emails: ["taro@example.com"],
  handoverDate: "2025/09/26",
  salesRep: "",
  memo: "",
};

const customer: Customer = {
  id: "dx:2101230101",
  source: "dx",
  sourceKey: "2101230101",
  sourceRow: 2,
  imported: fields,
  edits: {},
  issues: [],
  corporate: false,
  searchKey: "",
  importedAt: 0,
  editedAt: null,
};

describe("redactCustomer", () => {
  it("氏名・電話・住所・メールを伏せ字にしてから送る", () => {
    const text =
      "山田　太郎様より入電。東京都架空区北町1-2-3 の浴室換気扇から異音。連絡先は090-0000-1234 / taro@example.com";
    const out = redactCustomer(text, customer);
    expect(out).not.toContain("山田");
    expect(out).not.toContain("太郎");
    expect(out).not.toContain("090-0000-1234");
    expect(out).not.toContain("東京都架空区北町1-2-3");
    expect(out).not.toContain("taro@example.com");
    // 事象は残す
    expect(out).toContain("浴室換気扇から異音");
  });

  it("姓だけ・名だけの書き方でも消す", () => {
    expect(redactCustomer("山田さんから連絡", customer)).not.toContain("山田");
    expect(redactCustomer("太郎さんから連絡", customer)).not.toContain("太郎");
  });

  it("ハイフン無しの電話番号も消す", () => {
    expect(redactCustomer("連絡先09000001234", customer)).not.toContain("09000001234");
  });

  it("カナ表記の氏名も消す", () => {
    expect(redactCustomer("ヤマダ　タロウ 様", customer)).not.toContain("ヤマダ");
  });
});

describe("ruleBasedInquirySummary", () => {
  it("事象の文だけを残して①②で並べる", () => {
    const summary = ruleBasedInquirySummary(
      "お世話になっております。\n浴室の換気扇から異音がする。\n2階洋室の窓が閉まりにくい。\n明日折り返しご連絡します。",
    );
    expect(summary).toContain("浴室の換気扇から異音がする");
    expect(summary).toContain("2階洋室の窓が閉まりにくい");
    expect(summary).not.toContain("折り返し");
    expect(summary).not.toContain("お世話");
    expect(summary.split("\n")).toHaveLength(2);
    expect(summary.startsWith("①")).toBe(true);
  });

  it("1件だけなら番号を付けない", () => {
    expect(ruleBasedInquirySummary("浴室の換気扇から異音がする")).toBe("浴室の換気扇から異音がする");
  });

  it("段取りの文しか無ければ、落とす前の文をそのまま残す (空欄で登録しない)", () => {
    const summary = ruleBasedInquirySummary("折り返しご連絡します。よろしくお願いします。");
    expect(summary).not.toBe("");
    expect(summary).not.toContain(NO_DEFECT_TEXT);
    expect(summary).toContain("折り返しご連絡します");
  });

  it("短すぎて文が取れないときだけ空になる", () => {
    expect(ruleBasedInquirySummary("水漏れ")).toBe("");
  });

  it("長い文は切り詰める", () => {
    const summary = ruleBasedInquirySummary("あ".repeat(200));
    expect(summary.length).toBeLessThanOrEqual(81);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("buildInquiryPrompt", () => {
  it("受付メモを本文に含め、事象と依頼を分けて求める", () => {
    const prompt = buildInquiryPrompt("浴室の換気扇から異音");
    expect(prompt).toContain("浴室の換気扇から異音");
    expect(prompt).toContain("受付メモ");
    // 事象が無い依頼も拾えるようにする (空欄で登録されないため)
    expect(prompt).toContain("phenomena");
    expect(prompt).toContain("requests");
    expect(prompt).toContain("対応方針・訪問日程・折り返しの約束は入れない");
  });

  it("長さの上限が決まっている", () => {
    expect(INQUIRY_TEXT_MAX).toBe(4000);
  });
});
