import { describe, expect, it } from "vitest";
import {
  formatPhone,
  isPhoneToken,
  parseInspectionContacts,
} from "@/lib/pdf/parse-inspection-report";
import type { TextToken } from "@/lib/types";

// 実データと同じ座標配置 (番号・続柄は架空)
const t = (str: string, x: number, y: number, page = 1): TextToken => ({ str, x, y, page });
const header = [t("【チェックシート撮影①】", 62.2, 50.21), t("下部に署名欄有", 62.2, 64.44)];
const footer = [
  t("済", 508.06, 759.1),
  t("済", 507.69, 759.1),
  t("9時", 354.07, 778.58),
  t("18時", 449.61, 778.58),
];

describe("isPhoneToken", () => {
  it("ハイフン付きの携帯・固定電話を電話番号とみなす", () => {
    expect(isPhoneToken("090-0000-1234")).toBe(true);
    expect(isPhoneToken("03-0000-1234")).toBe(true);
    expect(isPhoneToken("0422-00-1234")).toBe(true);
  });

  it("全角ハイフン・長音記号の区切りも受ける", () => {
    expect(isPhoneToken("090－0000－1234")).toBe(true);
    expect(isPhoneToken("090ー0000ー1234")).toBe(true);
  });

  it("ハイフン無しは先頭0の10〜11桁のみ (契約番号の10桁は拾わない)", () => {
    expect(isPhoneToken("09000001234")).toBe(true);
    expect(isPhoneToken("0300001234")).toBe(true);
    expect(isPhoneToken("9900110101")).toBe(false); // 契約番号
    expect(isPhoneToken("2026")).toBe(false);
  });
});

describe("formatPhone", () => {
  it("ハイフン付きは区切りを半角に揃えるだけ (ok)", () => {
    expect(formatPhone("090－0000－1234")).toEqual({ phone: "090-0000-1234", confidence: "ok" });
    expect(formatPhone("090-0000-1234")).toEqual({ phone: "090-0000-1234", confidence: "ok" });
  });

  it("ハイフン無しは桁数から区切りを推定し warn を付ける", () => {
    expect(formatPhone("09000001234")).toEqual({ phone: "090-0000-1234", confidence: "warn" });
    expect(formatPhone("0300001234")).toEqual({ phone: "03-0000-1234", confidence: "warn" });
    expect(formatPhone("0600001234")).toEqual({ phone: "06-0000-1234", confidence: "warn" });
    expect(formatPhone("0120001234")).toEqual({ phone: "0120-001-234", confidence: "warn" });
    expect(formatPhone("0422001234")).toEqual({ phone: "042-200-1234", confidence: "warn" });
  });
});

describe("parseInspectionContacts", () => {
  it("電話番号①と続柄を取り出す (見本と同じ配置)", () => {
    const tokens = [...header, t("090-0000-1234", 142, 738.87), t("ご主人", 249.16, 738.87), ...footer];
    expect(parseInspectionContacts(tokens)).toEqual([
      { phone: "090-0000-1234", relation: "ご主人", confidence: "ok" },
    ]);
  });

  it("電話番号②がある場合は①②の順で返し、同じ行の「済」を続柄と誤認しない", () => {
    const tokens = [
      ...header,
      t("090-0000-1234", 142, 738.87),
      t("奥様", 254.03, 738.87),
      t("080-1111-2222", 142, 759.1),
      t("ご主人", 249.16, 759.1),
      ...footer, // 「済」×2 が y=759.1 の右端にある
    ];
    expect(parseInspectionContacts(tokens)).toEqual([
      { phone: "090-0000-1234", relation: "奥様", confidence: "ok" },
      { phone: "080-1111-2222", relation: "ご主人", confidence: "ok" },
    ]);
  });

  it("②の続柄が空欄なら relation は空 (「済」は拾わない)", () => {
    const tokens = [
      ...header,
      t("090-0000-1234", 142, 738.87),
      t("その他", 249.16, 738.87),
      t("080-1111-2222", 142, 759.1),
      ...footer,
    ];
    expect(parseInspectionContacts(tokens)[1]).toEqual({
      phone: "080-1111-2222",
      relation: "",
      confidence: "ok",
    });
  });

  it("全角ハイフンの番号も拾い、半角に揃える", () => {
    const tokens = [...header, t("０９０－００００－１２３４".normalize("NFKC").replace(/-/g, "－"), 142, 738.87), ...footer];
    expect(parseInspectionContacts(tokens)[0].phone).toBe("090-0000-1234");
  });

  it("番号が複数トークンに割れていても同じ行を連結して拾う", () => {
    const tokens = [
      ...header,
      t("090-", 142, 738.87),
      t("0000-1234", 170, 738.87),
      t("ご主人", 249.16, 738.87),
      ...footer,
    ];
    expect(parseInspectionContacts(tokens)).toEqual([
      { phone: "090-0000-1234", relation: "ご主人", confidence: "ok" },
    ]);
  });

  it("2ページ目のトークンは対象外", () => {
    const tokens = [...header, t("090-0000-1234", 142, 738.87, 2), ...footer];
    expect(parseInspectionContacts(tokens)).toEqual([]);
  });

  it("電話番号が無ければ空配列", () => {
    expect(parseInspectionContacts([...header, ...footer])).toEqual([]);
  });
});
