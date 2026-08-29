import { describe, expect, it } from "vitest";
import {
  DEVELOPER_41_RULES,
  developerFromBranch,
  resolveAfterDeveloper,
} from "@/lib/after/developer";
import {
  buildSearchKey,
  cleanPropertyName,
  isCorporateName,
  joinSeiMei,
  normalizeHandoverDate,
  normalizeOwnerKana,
  normalizeOwnerName,
  normalizeQuery,
  parsePhoneCell,
} from "@/lib/after/normalize";
import { managementIdToPj, parseBukkenNumber } from "@/lib/after/pj";
import type { CustomerFields } from "@/lib/after/types";

describe("managementIdToPj", () => {
  it("規則どおりに10桁のPJへ変換する", () => {
    expect(managementIdToPj("1234-5").pj).toBe("1012340101");
    expect(managementIdToPj("123-4").pj).toBe("1101230101");
    expect(managementIdToPj("12-3").pj).toBe("1100120101");
    expect(managementIdToPj("1-2").pj).toBe("1100010101");
    expect(managementIdToPj("B12-3").pj).toBe("2100120301");
  });

  it("全角・前後の空白・小文字を吸収する", () => {
    expect(managementIdToPj("　１２３４－５　").pj).toBe("1012340101");
    expect(managementIdToPj("b12-3").pj).toBe("2100120301");
  });

  it("DXの行は取り込まない", () => {
    expect(managementIdToPj("DX").skip).toBe("dx");
    expect(managementIdToPj("dx").skip).toBe("dx");
  });

  it("規則に無い形式はPJ空欄＋要確認にする", () => {
    for (const id of ["123-45", "123", "1234", "B1-2", "架空町3丁目", "NEXT1"]) {
      const result = managementIdToPj(id);
      expect(result.pj, id).toBeNull();
      expect(result.issue, id).toBeTruthy();
    }
  });

  it("空欄も要確認", () => {
    expect(managementIdToPj("").pj).toBeNull();
    expect(managementIdToPj("").issue).toBeTruthy();
  });
});

describe("parseBukkenNumber", () => {
  it("10桁の物件番号をそのまま使う", () => {
    expect(parseBukkenNumber("2101230101")).toEqual({ pj: "2101230101" });
  });

  it("(BS)付きは数字だけを取り出す", () => {
    expect(parseBukkenNumber("(BS)4101230101").pj).toBe("4101230101");
  });

  it("使用禁止・技術行・末尾01以外・形式不正は取り込まない", () => {
    expect(parseBukkenNumber("DONOTUSE(BS)2101230101").skipReason).toMatch(/使用禁止/);
    expect(parseBukkenNumber("bukken_number").skipReason).toMatch(/技術行/);
    expect(parseBukkenNumber("2101230180").skipReason).toMatch(/末尾が01以外/);
    expect(parseBukkenNumber("21012301").skipReason).toMatch(/形式が不正/);
  });
});

describe("resolveAfterDeveloper", () => {
  it("PJの先頭2桁で決まるもの", () => {
    expect(resolveAfterDeveloper("1001230101", "").developer).toBe("EU");
    expect(resolveAfterDeveloper("1101230101", "").developer).toBe("EU");
    expect(resolveAfterDeveloper("2101230101", "").developer).toBe("タカマツハウス");
    // 定期点検側と同じ表記に揃える
    expect(resolveAfterDeveloper("3101230101", "").developer).toBe("賃貸住宅事業部");
    expect(resolveAfterDeveloper("5101230101", "").developer).toBe("倉庫事業");
  });

  it("41始まりは物件名から判定する", () => {
    expect(resolveAfterDeveloper("4101230101", "SECUREA架空町1丁目").developer).toBe("大和ハウス工業");
    expect(resolveAfterDeveloper("4101230101", "セキュレア架空町").developer).toBe("大和ハウス工業");
    expect(resolveAfterDeveloper("4101230101", "リーフィア架空市").developer).toBe("小田急不動産");
    expect(resolveAfterDeveloper("4101230101", "三鷹市下連雀1丁目 2号棟").developer).toBe(
      "コスモスイニシア",
    );
    expect(resolveAfterDeveloper("4101230101", "北加瀬1丁目の家 A号棟").developer).toBe("福禄不動産");
    expect(resolveAfterDeveloper("4101230101", "鹿島田の家").developer).toBe("福禄不動産");
  });

  it("41始まりで判定できないものは空欄＋要確認 (画面で直す)", () => {
    const result = resolveAfterDeveloper("4101230101", "架空　太郎様邸");
    expect(result.developer).toBeNull();
    expect(result.issue).toMatch(/41始まり/);
  });

  it("PJが無い・想定外の先頭2桁も要確認", () => {
    expect(resolveAfterDeveloper(null, "").issue).toBeTruthy();
    expect(resolveAfterDeveloper("9901230101", "").issue).toBeTruthy();
  });

  it("41始まりの規則は表で持つ (追加しやすくする)", () => {
    expect(DEVELOPER_41_RULES.length).toBeGreaterThanOrEqual(4);
  });
});

describe("developerFromBranch", () => {
  it("エンドユーザーはEUに、空欄はnullにする", () => {
    expect(developerFromBranch("エンドユーザー")).toBe("EU");
    expect(developerFromBranch("")).toBeNull();
    expect(developerFromBranch("　")).toBeNull();
  });

  it("それ以外の会社名はそのまま", () => {
    expect(developerFromBranch("架空建設")).toBe("架空建設");
  });
});

describe("cleanPropertyName", () => {
  it("装飾を落とす", () => {
    expect(cleanPropertyName("(仮称)123.架空区北町1-2-3 A号棟(全3棟)　新築工事")).toBe(
      "123.架空区北町1-2-3 A号棟",
    );
    expect(cleanPropertyName("（仮称）セキュレア架空町1丁目 2号地（全6区画）　新築工事")).toBe(
      "セキュレア架空町1丁目 2号地",
    );
    expect(cleanPropertyName("(BS)架空台2丁目　5号棟")).toBe("架空台2丁目 5号棟");
    expect(cleanPropertyName("（仮称）架空市南町1丁目 3号棟（第2期4区画）　新築工事")).toBe(
      "架空市南町1丁目 3号棟",
    );
    expect(cleanPropertyName("(仮称)SECUREA架空西町1丁目　分譲住宅新築工事")).toBe(
      "SECUREA架空西町1丁目",
    );
  });

  it("半角カナを全角にする", () => {
    expect(cleanPropertyName("（仮称）ｾｷｭﾚｱ架空本町1丁目(全2区画)　新築工事")).toBe(
      "セキュレア架空本町1丁目",
    );
  });

  it("先頭のタブや余分な空白を落とす", () => {
    expect(cleanPropertyName("\t（仮称）架空町1丁目 　新築工事")).toBe("架空町1丁目");
  });
});

describe("normalizeOwnerName", () => {
  it("個人名は姓名の間を全角スペースにする", () => {
    expect(normalizeOwnerName("山田 太郎").name).toBe("山田　太郎");
    expect(normalizeOwnerName("　山田　太郎　").name).toBe("山田　太郎");
  });

  it("区切りの無い個人名は分割せず要確認にする", () => {
    const result = normalizeOwnerName("山田太郎");
    expect(result.name).toBe("山田太郎");
    expect(result.issue).toMatch(/区切り/);
  });

  it("法人名は空白も含めてそのまま", () => {
    const result = normalizeOwnerName("株式会社 架空建設");
    expect(result.name).toBe("株式会社 架空建設");
    expect(result.corporate).toBe(true);
    expect(result.issue).toBeUndefined();
  });

  it("空欄は要確認", () => {
    expect(normalizeOwnerName("").issue).toBeTruthy();
  });
});

describe("joinSeiMei", () => {
  it("姓の末尾の全角スペースを落として結合する", () => {
    expect(joinSeiMei("山田　", "太郎")).toBe("山田　太郎");
    expect(joinSeiMei("山田", "")).toBe("山田");
    expect(joinSeiMei("", "太郎")).toBe("太郎");
    expect(joinSeiMei("", "")).toBe("");
  });
});

describe("normalizeOwnerKana", () => {
  it("ひらがな・半角カナをカタカナにする", () => {
    expect(normalizeOwnerKana("やまだ　たろう").kana).toBe("ヤマダ　タロウ");
    expect(normalizeOwnerKana("ﾔﾏﾀﾞ ﾀﾛｳ").kana).toBe("ヤマダ　タロウ");
  });

  it("半角スペースは全角にそろえる", () => {
    expect(normalizeOwnerKana("ヤマダ タロウ").kana).toBe("ヤマダ　タロウ");
  });

  it("空欄はそのまま (要確認にはしない)", () => {
    expect(normalizeOwnerKana("")).toEqual({ kana: "" });
  });

  it("漢字が混ざる個人名のカナは要確認", () => {
    expect(normalizeOwnerKana("ヤマダ太郎").issue).toBeTruthy();
  });
});

describe("parsePhoneCell", () => {
  it("ハイフン付きの番号をそのまま使う", () => {
    expect(parsePhoneCell("090-0000-1234")).toEqual({
      phone: "090-0000-1234",
      relation: "",
      confidence: "ok",
    });
  });

  it("末尾の続柄を分けて表記をそろえる", () => {
    expect(parsePhoneCell("090-0000-1234（奥様）")).toMatchObject({
      phone: "090-0000-1234",
      relation: "奥様",
    });
    expect(parsePhoneCell("090-0000-1234(ご主人)")).toMatchObject({ relation: "ご主人" });
    expect(parsePhoneCell("090-0000-1234（御主人）")).toMatchObject({ relation: "ご主人" });
    expect(parsePhoneCell("090-0000-1234 奥さま")).toMatchObject({ relation: "奥様" });
  });

  it("ハイフン無しは桁数から推定し要確認にする", () => {
    expect(parsePhoneCell("09000001234")).toEqual({
      phone: "090-0000-1234",
      relation: "",
      confidence: "warn",
    });
  });

  it("桁数が合わない番号は要確認", () => {
    expect(parsePhoneCell("1234")).toMatchObject({ confidence: "warn" });
  });

  it("空欄は連絡先にしない", () => {
    expect(parsePhoneCell("")).toBeNull();
    expect(parsePhoneCell("　")).toBeNull();
    expect(parsePhoneCell("なし")).toBeNull();
  });
});

describe("normalizeHandoverDate", () => {
  it("ゼロ埋めした yyyy/mm/dd にする", () => {
    expect(normalizeHandoverDate("2025/9/26").date).toBe("2025/09/26");
    expect(normalizeHandoverDate("2025/09/26").date).toBe("2025/09/26");
    expect(normalizeHandoverDate("2025-9-26").date).toBe("2025/09/26");
    expect(normalizeHandoverDate("2025年9月26日").date).toBe("2025/09/26");
  });

  it("空欄はnull (要確認にしない)", () => {
    expect(normalizeHandoverDate("")).toEqual({ date: null });
  });

  it("読めない形式は要確認", () => {
    expect(normalizeHandoverDate("未定").issue).toBeTruthy();
  });
});

describe("検索キー", () => {
  const fields: CustomerFields = {
    pj: "2101230101",
    developer: "タカマツハウス",
    propertyName: "セキュレア架空町1丁目 2号地",
    ownerName: "山田　太郎",
    ownerKana: "ヤマダ　タロウ",
    address: "東京都架空区北町1-2-3",
    contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
    emails: ["taro@example.com"],
    handoverDate: "2025/09/26",
    salesRep: "",
    memo: "",
  };

  it("ひらがな・カタカナ・ハイフンの違いを吸収する", () => {
    const key = buildSearchKey(fields);
    expect(key).toContain("ヤマダタロウ");
    for (const query of ["やまだ", "ヤマダ", "山田", "09000001234", "090-0000-1234", "2101230101"]) {
      expect(normalizeQuery(query).every((t) => key.includes(t)), query).toBe(true);
    }
  });

  it("複数語はAND条件になる", () => {
    expect(normalizeQuery("山田 架空区")).toEqual(["山田", "架空区"]);
    expect(normalizeQuery("　 ")).toEqual([]);
  });
});

describe("isCorporateName", () => {
  it("会社らしい名前を見分ける", () => {
    expect(isCorporateName("株式会社架空")).toBe(true);
    expect(isCorporateName("㈱架空")).toBe(true);
    expect(isCorporateName("架空建設")).toBe(true);
    expect(isCorporateName("山田　太郎")).toBe(false);
  });
});
