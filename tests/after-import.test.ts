import { describe, expect, it } from "vitest";
import { applyEdits, effectiveFields, mergeImported, openIssues, resetEdits, searchCustomers } from "@/lib/after/customer";
import { CustomerImportError, countNeedsReview, findPjCollisions, parseCustomerFile } from "@/lib/after/import";
import { buildXlsx } from "./helpers/xlsx-fixture";

// 助っ人クラウド (旧システム) の列。実ファイルは個人情報を含むため使わない
const SUKETTO_HEADER = [
  "※必須\n施主名（姓）",
  "※必須\n施主名（名）",
  "※必須\n施主名かな（姓）",
  "※必須\n施主名かな（名）",
  "建築地電話番号",
  "建築地携帯電話番号",
  "住宅名(物件名)(区画番号)など",
  "※必須\n建築地都道府県",
  "※必須\n建築地市区町村番地",
  "管理ID",
  "引渡日",
  "担当支店",
];

const suketRow = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    sei: "山田　",
    mei: "太郎",
    seiKana: "やまだ",
    meiKana: "たろう",
    tel: "",
    mobile: "090-0000-1234",
    property: "架空台1丁目　A号棟　新築工事",
    prefecture: "東京都",
    city: "架空区北町1-2-3",
    managementId: "1234-5",
    handover: "2025/09/26",
    branch: "エンドユーザー",
    ...over,
  };
  return [
    base.sei,
    base.mei,
    base.seiKana,
    base.meiKana,
    base.tel,
    base.mobile,
    base.property,
    base.prefecture,
    base.city,
    base.managementId,
    base.handover,
    base.branch,
  ];
};

const suketFile = (rows: string[][]) =>
  buildXlsx([{ name: "住宅情報登録用シート", rows: [SUKETTO_HEADER, ...rows] }]);

// 点検保守台帳 (DX) の列
const DX_HEADER = [
  "台帳種類",
  "更新区分",
  "物件番号",
  "物件名",
  "居住者 お客様番号",
  "居住者名",
  "居住者名カナ",
  "所在地住居表示",
  "所在地住居表示 - 建物名",
  "居住者 連絡先1 - TEL1",
  "居住者 連絡先1 - email1",
  "居住者 連絡先1 - TEL2",
  "居住者 連絡先1 - email2",
  "営業担当 担当者(主)",
  "備考",
];

const dxRow = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    ledger: "点検・保守台帳",
    update: "更新",
    bukken: "2101230101",
    property: "(仮称)123.架空区北町1-2-3 A号棟(全3棟)　新築工事",
    customerNo: "C-1",
    owner: "架空　花子",
    kana: "カクウ　ハナコ",
    address: "東京都架空区北町1-2-3",
    building: "",
    tel1: "080-0000-5678",
    email1: "hanako@example.com",
    tel2: "",
    email2: "",
    sales: "営業担当",
    memo: "",
    ...over,
  };
  return [
    base.ledger,
    base.update,
    base.bukken,
    base.property,
    base.customerNo,
    base.owner,
    base.kana,
    base.address,
    base.building,
    base.tel1,
    base.email1,
    base.tel2,
    base.email2,
    base.sales,
    base.memo,
  ];
};

const DX_TECHNICAL_ROW = dxRow({
  ledger: "importMaster",
  update: "importOperation",
  bukken: "bukken_number",
  property: "bukken_name",
  owner: "kyojyusya_name",
  kana: "kyojyusya_kana",
  address: "jukyo_address",
  tel1: "kyojyusya_customer_address_tel1_1",
  email1: "kyojyusya_customer_address_email1_1",
});

const dxFile = (rows: string[][]) =>
  buildXlsx([{ name: "Sheet1", rows: [DX_HEADER, ...rows] }], { mode: "inline" });

describe("parseCustomerFile (助っ人クラウド)", () => {
  it("列を対応付けて顧客にする", () => {
    const result = parseCustomerFile(suketFile([suketRow()]), "助っ人.xlsx", 1000);
    expect(result.source).toBe("suketto");
    expect(result.sheetName).toBe("住宅情報登録用シート");
    expect(result.customers).toHaveLength(1);
    const fields = effectiveFields(result.customers[0]);
    expect(fields).toMatchObject({
      pj: "1012340101",
      developer: "EU",
      propertyName: "架空台1丁目 A号棟",
      ownerName: "山田　太郎",
      ownerKana: "ヤマダ　タロウ",
      address: "東京都架空区北町1-2-3",
      handoverDate: "2025/09/26",
      emails: [],
    });
    expect(fields.contacts).toEqual([
      { phone: "090-0000-1234", relation: "", confidence: "ok" },
    ]);
  });

  it("携帯・固定の両方があれば 携帯→固定 の順に並べる", () => {
    const result = parseCustomerFile(
      suketFile([suketRow({ tel: "03-0000-1111", mobile: "090-0000-2222（奥様）" })]),
      "f.xlsx",
      1,
    );
    expect(effectiveFields(result.customers[0]).contacts).toEqual([
      { phone: "090-0000-2222", relation: "奥様", confidence: "ok" },
      { phone: "03-0000-1111", relation: "", confidence: "ok" },
    ]);
  });

  it("管理IDがDXの行は取り込まない", () => {
    const result = parseCustomerFile(
      suketFile([suketRow(), suketRow({ managementId: "DX" })]),
      "f.xlsx",
      1,
    );
    expect(result.customers).toHaveLength(1);
    expect(result.skipped).toContainEqual({
      reason: "管理IDがDX (点検保守台帳側で管理)",
      count: 1,
      rows: [3],
    });
  });

  it("内容が完全に同じ行は1件にまとめる", () => {
    const result = parseCustomerFile(suketFile([suketRow(), suketRow()]), "f.xlsx", 1);
    expect(result.customers).toHaveLength(1);
    expect(result.skipped.find((s) => s.reason === "内容が同じ行")?.count).toBe(1);
    expect(result.totalRows).toBe(2);
  });

  it("管理IDが同じでも内容が違えば別の顧客にする", () => {
    const result = parseCustomerFile(
      suketFile([
        suketRow({ managementId: "12-3" }),
        suketRow({ managementId: "12-3", sei: "鈴木　", mei: "次郎", seiKana: "すずき", meiKana: "じろう" }),
      ]),
      "f.xlsx",
      1,
    );
    expect(result.customers).toHaveLength(2);
    // 同じ管理IDなのでPJも同じになる (検索結果では物件名・住所で見分ける)
    expect(result.customers.map((c) => effectiveFields(c).pj)).toEqual([
      "1100120101",
      "1100120101",
    ]);
  });

  it("規則外の管理ID・空の担当支店は要確認にする (登録はする)", () => {
    const result = parseCustomerFile(
      suketFile([suketRow({ managementId: "架空町3丁目", branch: "" })]),
      "f.xlsx",
      1,
    );
    const customer = result.customers[0];
    expect(effectiveFields(customer).pj).toBeNull();
    expect(openIssues(customer).map((i) => i.field)).toEqual(
      expect.arrayContaining(["pj", "developer"]),
    );
    expect(countNeedsReview(result.customers)).toBe(1);
  });

  it("ひらがなのかなをカタカナにする", () => {
    const result = parseCustomerFile(
      suketFile([suketRow({ seiKana: "すずき", meiKana: "じろう" })]),
      "f.xlsx",
      1,
    );
    expect(effectiveFields(result.customers[0]).ownerKana).toBe("スズキ　ジロウ");
  });

  it("空行は取り込まない", () => {
    const result = parseCustomerFile(
      suketFile([suketRow(), SUKETTO_HEADER.map(() => "")]),
      "f.xlsx",
      1,
    );
    expect(result.customers).toHaveLength(1);
    expect(result.skipped.find((s) => s.reason === "空行")?.count).toBe(1);
  });
});

describe("parseCustomerFile (点検保守台帳)", () => {
  it("列を対応付けて顧客にする", () => {
    const result = parseCustomerFile(dxFile([DX_TECHNICAL_ROW, dxRow()]), "DX.xlsx", 2000);
    expect(result.source).toBe("dx");
    expect(result.customers).toHaveLength(1);
    const customer = result.customers[0];
    expect(customer.id).toBe("dx:2101230101");
    expect(effectiveFields(customer)).toMatchObject({
      pj: "2101230101",
      developer: "タカマツハウス",
      propertyName: "123.架空区北町1-2-3 A号棟",
      ownerName: "架空　花子",
      ownerKana: "カクウ　ハナコ",
      address: "東京都架空区北町1-2-3",
      // 点検保守台帳には引渡日の列が無い
      handoverDate: null,
      emails: ["hanako@example.com"],
    });
  });

  it("技術行を取り込まない", () => {
    const result = parseCustomerFile(dxFile([DX_TECHNICAL_ROW, dxRow()]), "DX.xlsx", 1);
    expect(result.skipped.find((s) => s.reason === "技術行 (見出しのキー)")?.count).toBe(1);
  });

  it("使用禁止・末尾01以外は取り込まない", () => {
    const result = parseCustomerFile(
      dxFile([
        dxRow(),
        dxRow({ bukken: "DONOTUSE(BS)2101230101", property: "×使用禁止×架空台" }),
        dxRow({ bukken: "2101230180" }),
      ]),
      "DX.xlsx",
      1,
    );
    expect(result.customers).toHaveLength(1);
    const reasons = result.skipped.map((s) => s.reason);
    expect(reasons).toContain("物件名が×使用禁止× (助っ人クラウド側にある物件)");
    expect(reasons).toContain("物件番号の末尾が01以外");
  });

  it("(BS)付きの物件番号は数字部分を使う", () => {
    const result = parseCustomerFile(dxFile([dxRow({ bukken: "(BS)3101230101" })]), "DX.xlsx", 1);
    expect(effectiveFields(result.customers[0])).toMatchObject({
      pj: "3101230101",
      developer: "賃貸住宅事業部",
    });
  });

  it("建物名は住所の末尾に付ける", () => {
    const result = parseCustomerFile(
      dxFile([dxRow({ building: "架空マンション101" })]),
      "DX.xlsx",
      1,
    );
    expect(effectiveFields(result.customers[0]).address).toBe(
      "東京都架空区北町1-2-3　架空マンション101",
    );
  });

  it("TEL1・TEL2 の順に連絡先を並べ、メールも2つまで取る", () => {
    const result = parseCustomerFile(
      dxFile([
        dxRow({
          tel1: "080-0000-1111",
          tel2: "03-0000-2222",
          email1: "a@example.com",
          email2: "b@example.com",
        }),
      ]),
      "DX.xlsx",
      1,
    );
    const fields = effectiveFields(result.customers[0]);
    expect(fields.contacts.map((c) => c.phone)).toEqual(["080-0000-1111", "03-0000-2222"]);
    expect(fields.emails).toEqual(["a@example.com", "b@example.com"]);
  });

  it("41始まりで判定できない物件は事業者を空欄＋要確認にする", () => {
    const result = parseCustomerFile(
      dxFile([dxRow({ bukken: "4101230101", property: "(仮称)架空　太郎様邸新築工事" })]),
      "DX.xlsx",
      1,
    );
    const customer = result.customers[0];
    expect(effectiveFields(customer).developer).toBeNull();
    expect(openIssues(customer).some((i) => i.field === "developer")).toBe(true);
  });

  it("同じファイルを再度読んでもIDが変わらない (編集を残せる)", () => {
    const bytes = dxFile([dxRow()]);
    const a = parseCustomerFile(bytes, "DX.xlsx", 1);
    const b = parseCustomerFile(bytes, "DX.xlsx", 2);
    expect(a.customers[0].id).toBe(b.customers[0].id);
  });
});

describe("parseCustomerFile (共通)", () => {
  it("CSVでも読める", () => {
    const csv = [DX_HEADER.join(","), dxRow({ property: '"架空,台"' }).join(",")].join("\n");
    const result = parseCustomerFile(new TextEncoder().encode(csv), "DX.csv", 1);
    expect(result.source).toBe("dx");
    expect(result.customers).toHaveLength(1);
  });

  it("形式が分からないファイルはエラー", () => {
    const bytes = buildXlsx([{ name: "S", rows: [["適当", "な", "列"], ["a", "b", "c"]] }]);
    expect(() => parseCustomerFile(bytes, "x.xlsx", 1)).toThrow(CustomerImportError);
  });

  it("説明行が上にあってもヘッダー行を見つける", () => {
    const bytes = buildXlsx([
      { name: "住宅情報登録用シート", rows: [["この表は…"], [], SUKETTO_HEADER, suketRow()] },
    ]);
    const result = parseCustomerFile(bytes, "f.xlsx", 1);
    expect(result.customers).toHaveLength(1);
  });

  it("スキップの報告に顧客名を含めない (行番号だけ)", () => {
    const result = parseCustomerFile(
      suketFile([suketRow({ managementId: "DX" })]),
      "f.xlsx",
      1,
    );
    const json = JSON.stringify(result.skipped);
    expect(json).not.toContain("山田");
    expect(json).toContain("2");
  });
});

describe("顧客の編集", () => {
  const load = () =>
    parseCustomerFile(
      dxFile([dxRow({ bukken: "4101230101", property: "(仮称)架空　太郎様邸新築工事" })]),
      "DX.xlsx",
      1,
    ).customers[0];

  it("修正した項目は取り込み値より優先され、要確認が解消される", () => {
    const edited = applyEdits(load(), { developer: "大和ハウス工業" }, 2);
    expect(effectiveFields(edited).developer).toBe("大和ハウス工業");
    expect(openIssues(edited).some((i) => i.field === "developer")).toBe(false);
    expect(edited.editedAt).toBe(2);
  });

  it("取り込み値と同じ値に戻したら修正から外す", () => {
    const customer = load();
    const edited = applyEdits(customer, { propertyName: "変更" }, 2);
    expect(edited.edits.propertyName).toBe("変更");
    const back = applyEdits(edited, { propertyName: customer.imported.propertyName }, 3);
    expect(back.edits).toEqual({});
  });

  it("再取込しても修正が残る", () => {
    const edited = applyEdits(load(), { developer: "大和ハウス工業" }, 2);
    const merged = mergeImported(edited, load());
    expect(effectiveFields(merged).developer).toBe("大和ハウス工業");
  });

  it("再取込で取り込み値が修正と同じになったら修正を外す", () => {
    const customer = load();
    const edited = applyEdits(customer, { developer: "大和ハウス工業" }, 2);
    const incoming = { ...customer, imported: { ...customer.imported, developer: "大和ハウス工業" } };
    expect(mergeImported(edited, incoming).edits).toEqual({});
  });

  it("取り込み値に戻せる", () => {
    const edited = applyEdits(load(), { developer: "大和ハウス工業" }, 2);
    expect(effectiveFields(resetEdits(edited, 3)).developer).toBeNull();
  });

  it("修正すると検索キーも更新される", () => {
    const edited = applyEdits(load(), { ownerName: "鈴木　次郎" }, 2);
    expect(edited.searchKey).toContain("鈴木");
  });
});

describe("searchCustomers", () => {
  const customers = parseCustomerFile(
    dxFile([
      dxRow(),
      dxRow({ bukken: "2101230201", owner: "鈴木　次郎", kana: "スズキ　ジロウ", tel1: "090-0000-9999" }),
    ]),
    "DX.xlsx",
    1,
  ).customers;

  it("氏名・カナ・電話・PJで探せる", () => {
    for (const query of ["カクウ", "かくう", "花子", "080-0000-5678", "08000005678", "2101230101"]) {
      expect(searchCustomers(customers, query).matched, query).toHaveLength(1);
    }
  });

  it("空の検索語は先頭から返す", () => {
    expect(searchCustomers(customers, "").matched).toHaveLength(2);
  });

  it("上限を超えた分は件数だけ返す", () => {
    const result = searchCustomers(customers, "架空", 1);
    expect(result.matched).toHaveLength(1);
    expect(result.total).toBe(2);
  });
});

describe("findPjCollisions", () => {
  it("助っ人クラウドと点検保守台帳で同じPJがあれば拾う", () => {
    const suketto = parseCustomerFile(
      suketFile([suketRow({ managementId: "1234-5" })]),
      "f.xlsx",
      1,
    ).customers;
    const dx = parseCustomerFile(dxFile([dxRow({ bukken: "1012340101" })]), "DX.xlsx", 1).customers;
    const collisions = findPjCollisions([...suketto, ...dx]);
    expect([...collisions.keys()]).toEqual(["1012340101"]);
  });
});
