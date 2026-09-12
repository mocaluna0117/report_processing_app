import { describe, expect, it } from "vitest";
import {
  normalizeDenpyoDigits,
  normalizePersonName,
  parseLabeledField,
  parsePj,
  parsePropertyName,
  parseStaffNames,
} from "@/lib/rakuraku/parse/fields";

// 期待値は移植元の検証 (tenmatsu-dl/server_test.py・smoke_test.py) から写した。すべて架空の値
describe("物件名 — 「どこで」の書き方ごとの取り出し", () => {
  const cases: [string | null, string | null][] = [
    ["注文受注物件：テスト物件A 施主名：テスト 太郎", "テスト物件A"],
    ["注文受注物件：テスト物件A　施主名：テスト 太郎", "テスト物件A"], // 全角空白
    ["法人受注物件：テスト法人物件B", "テスト法人物件B"],
    ["受注物件：物件だけ", "物件だけ"],
    ["テスト物件D", null], // 「受注物件」を含まない
    ["注文受注物件：", null], // 物件名が空
    ["", null],
    [null, null],
  ];
  for (const [where, want] of cases) {
    it(`${JSON.stringify(where)} → ${JSON.stringify(want)}`, () => {
      expect(parsePropertyName(where)).toBe(want);
    });
  }

  it("★空白が無ければ切る位置を決められないので、切らずに返す", () => {
    expect(parsePropertyName("注文受注物件：テスト物件A施主名：テスト")).toBe(
      "テスト物件A施主名：テスト",
    );
  });
});

describe("「〇〇：値」の切り出し", () => {
  it("ラベルの後ろを取る", () => {
    expect(parseLabeledField("物件名：架空台1丁目A号棟　工事内容：外壁補修", "物件名")).toBe(
      "架空台1丁目A号棟",
    );
  });
  it("「/」でも切れる", () => {
    expect(parseLabeledField("物件名：架空台/工事内容：外壁", "物件名")).toBe("架空台");
  });
  it("改行でも切れる", () => {
    expect(parseLabeledField("物件名：架空台\n工事内容：外壁", "物件名")).toBe("架空台");
  });
  it("半角コロンでも読む", () => {
    expect(parseLabeledField("物件名:架空台", "物件名")).toBe("架空台");
  });
  it("★ラベルが無ければ null（推測で埋めない）", () => {
    expect(parseLabeledField("工事内容：外壁補修", "物件名")).toBeNull();
  });
  it("値が空でも null", () => {
    expect(parseLabeledField("物件名：", "物件名")).toBeNull();
  });
  it("空・null で落ちない", () => {
    expect(parseLabeledField("", "物件名")).toBeNull();
    expect(parseLabeledField(null, "物件名")).toBeNull();
  });
  it("★別のラベルの一部に当たらない", () => {
    expect(parseLabeledField("旧物件名：X", "物件名")).toBeNull();
  });
  it("備考の途中にあるラベルも読む（捺印決裁書）", () => {
    expect(parseLabeledField("保険申請分　物件名：架空邸", "物件名")).toBe("架空邸");
  });
  it("ラベルに正規表現の記号が入っていても壊れない", () => {
    expect(parseLabeledField("決裁申請額(税込)：1,000円", "決裁申請額(税込)")).toBe("1,000円");
  });
});

describe("監督・営業", () => {
  const where = "注文受注物件：テスト物件A　施主名：テスト 太郎　監督：架空　一郎/営業：架空　二郎";

  it("監督・営業を取り出し、姓名の間を半角スペース1つにする", () => {
    expect(parseStaffNames(where)).toEqual({ supervisor: "架空 一郎", sales_rep: "架空 二郎" });
  });
  it("全角コロン・半角コロンのどちらでも読む", () => {
    expect(parseStaffNames("監督:架空 一郎/営業:架空 二郎").supervisor).toBe("架空 一郎");
  });
  it("区切りが「/」でなくても次のラベルで切れる", () => {
    expect(parseStaffNames("監督：架空　一郎　営業：架空　二郎")).toEqual({
      supervisor: "架空 一郎",
      sales_rep: "架空 二郎",
    });
  });
  it("★形が違うもの（監督・営業が無い）は無視する", () => {
    expect(parseStaffNames("注文受注物件：テスト物件A　施主名：テスト 太郎")).toEqual({
      supervisor: null,
      sales_rep: null,
    });
  });
  it("★値が空のものも入れない", () => {
    expect(parseStaffNames("監督：/営業：").supervisor).toBeNull();
  });
  it("片方だけでも読める", () => {
    const got = parseStaffNames("監督：架空 三郎");
    expect(got.supervisor).toBe("架空 三郎");
    expect(got.sales_rep).toBeNull();
  });
  it("空・null で落ちない", () => {
    expect(parseStaffNames(null)).toEqual({ supervisor: null, sales_rep: null });
    expect(parseStaffNames("")).toEqual({ supervisor: null, sales_rep: null });
  });
  it("★氏名そのものは書き換えない（空白の入れ方だけ揃える）", () => {
    expect(normalizePersonName("架空　　一郎")).toBe("架空 一郎");
    expect(normalizePersonName("架空一郎")).toBe("架空一郎");
    expect(normalizePersonName("　")).toBeNull();
  });
});

describe("PJコード", () => {
  it("10桁の数字だけ通す（全角・ハイフンは吸収）", () => {
    expect(parsePj("９９０１２３０１０１")).toBe("9901230101");
    expect(parsePj("9901-23-0101")).toBe("9901230101");
  });
  it("★10桁でない値は null（推測で埋めない）", () => {
    expect(parsePj("990123010")).toBeNull();
    expect(parsePj("99012301010")).toBeNull();
    expect(parsePj("PJ9901230101")).toBeNull();
    expect(parsePj("")).toBeNull();
    expect(parsePj(null)).toBeNull();
  });
});

describe("伝票No.の比べ方", () => {
  it("先頭の0を落として同じと見なす", () => {
    expect(normalizeDenpyoDigits("00002267")).toBe("2267");
  });
  it("文字の接頭辞も落とす", () => {
    expect(normalizeDenpyoDigits("SE2267")).toBe("2267");
  });
  it("空なら null", () => {
    expect(normalizeDenpyoDigits("")).toBeNull();
    expect(normalizeDenpyoDigits(null)).toBeNull();
  });
  it("数字が1つも無ければ null（推測で埋めない）", () => {
    expect(normalizeDenpyoDigits("なし")).toBeNull();
  });
  it("全角で書かれた番号も同じ番号として扱う", () => {
    expect(normalizeDenpyoDigits("ＳＥ００００２２６７")).toBe("2267");
  });
});
