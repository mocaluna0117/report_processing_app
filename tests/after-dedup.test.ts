import { describe, expect, it } from "vitest";
import { effectiveFields, withSupplements } from "@/lib/after/customer";
import {
  DUPLICATE_ISSUE,
  addressKey,
  compareAddress,
  nameKey,
  propertyKey,
  resolveDuplicates,
  unitToken,
  withDuplicateIssue,
} from "@/lib/after/dedup";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";

// 実データは個人情報なので使わず、実ファイルで見つかった「形」だけを写した架空のデータで確かめる
const fields = (over: Partial<CustomerFields> = {}): CustomerFields => ({
  pj: null,
  developer: "EU",
  propertyName: "架空 太郎 様邸",
  ownerName: "架空　太郎",
  ownerKana: "カクウ　タロウ",
  address: "東京都架空区北町1-2-3",
  contacts: [],
  emails: [],
  handoverDate: null,
  salesRep: "",
  memo: "",
  ...over,
});

const customer = (
  id: string,
  source: CustomerSource,
  over: Partial<CustomerFields> = {},
): Customer => ({
  id,
  source,
  sourceKey: id,
  sourceRow: 2,
  imported: fields(over),
  edits: {},
  issues: [],
  corporate: false,
  searchKey: id,
  importedAt: 1,
  editedAt: null,
});

const sk = (id: string, over: Partial<CustomerFields> = {}) => customer(`sk:${id}`, "suketto", over);
const dx = (id: string, over: Partial<CustomerFields> = {}) =>
  customer(`dx:${id}`, "dx", { pj: id, ...over });

describe("照合キー", () => {
  it("住所は「3丁目14番10号」と「3-14-10」を同じ形にする", () => {
    expect(addressKey("東京都架空市羽衣町3丁目14番10号")).toBe(addressKey("東京都架空市羽衣町3-14-10"));
  });

  it("住所は全角ハイフン・空白・記号の違いを吸収する", () => {
    expect(addressKey("神奈川県架空市元大橋2‐14-18")).toBe(addressKey("神奈川県架空市元大橋2-14-18"));
  });

  it("氏名は法人格と肩書き・括弧書きを落とす", () => {
    expect(nameKey("株式会社　架空建設　代表取締役　架空　太郎")).toBe(nameKey("架空建設架空太郎"));
    expect(nameKey("架空　太郎（架空　花子）")).toBe(nameKey("架空　太郎"));
  });

  it("棟・区画の記号を取り出す (書き方の違いを吸収する)", () => {
    expect(unitToken("架空町戸建C棟")).toBe("C");
    expect(unitToken("架空町戸建新築計画C号棟")).toBe("C");
    expect(unitToken("架空区北町 3号棟")).toBe("3");
    expect(unitToken("小金井市前原町4丁目A区画")).toBe("A");
    expect(unitToken("北山田6丁目 5号地")).toBe("5");
    expect(unitToken("架空台1丁目Ａ号棟")).toBe("A");
    // 棟の記号が無ければ制約なし (空文字)
    expect(unitToken("港北区大倉山2丁目共同住宅")).toBe("");
    expect(unitToken("架空 太郎 様邸")).toBe("");
  });

  it("物件名は括弧書き・【】・「新築工事/新築計画」を落とす", () => {
    expect(propertyKey("架空区北町2丁目長屋 新築計画")).toBe(propertyKey("架空区北町2丁目長屋"));
    expect(propertyKey("【HL】架空プロジェクト")).toBe(propertyKey("架空プロジェクト"));
    expect(propertyKey("架空1丁目 3号棟（点検注意！）")).toBe(propertyKey("架空1丁目 3号棟"));
  });
});

describe("compareAddress", () => {
  it("どちらかが空なら unknown", () => {
    expect(compareAddress("", "a")).toBe("unknown");
  });

  it("建物名が付いただけなら同じ住所とみなす", () => {
    // 点検保守台帳の住所は「所在地住居表示 + 建物名」
    expect(compareAddress(addressKey("東京都架空区北町2-12-9"), addressKey("東京都架空区北町2-12-9ソラ　ソラ"))).toBe("extends");
  });

  it("枝番が付いただけなら同じ住所とみなす", () => {
    expect(compareAddress(addressKey("東京都架空区北町44-1"), addressKey("東京都架空区北町44-1-3"))).toBe("extends");
  });

  it("番地の数字が違えば別の住所", () => {
    expect(compareAddress(addressKey("東京都架空区北町2-12-9"), addressKey("東京都架空区北町2-12-91"))).toBe("conflict");
    expect(compareAddress(addressKey("東京都架空区北町1-2-3"), addressKey("神奈川県架空市南町4-5-6"))).toBe("conflict");
  });
});

describe("resolveDuplicates", () => {
  it("氏名と住所がそろえば助っ人クラウド側を消す", () => {
    const s = sk("a", { ownerName: "架空　太郎", address: "東京都架空区北町1-2-3" });
    const d = dx("1012340101", { ownerName: "架空　太郎", address: "東京都架空区北町1-2-3" });
    const result = resolveDuplicates([s], [d]);
    expect([...result.removeIds]).toEqual(["sk:a"]);
    expect(result.uncertainIds.size).toBe(0);
  });

  it("PJだけの一致では消さない (助っ人クラウドの管理ID→PJ変換は別人のPJと衝突する)", () => {
    const s = sk("a", { pj: "1012340101", ownerName: "架空　太郎", address: "東京都架空区北町1-2-3" });
    const d = dx("1012340101", { ownerName: "架空　次郎", address: "神奈川県架空市南町4-5-6" });
    expect(resolveDuplicates([s], [d]).removeIds.size).toBe(0);
  });

  it("物件名だけの一致では消さない (事業者違いで同じ物件名がある)", () => {
    const s = sk("a", { propertyName: "架空が丘4丁目 A号棟", ownerName: "架空　太郎", address: "東京都架空区北町1-2-3" });
    const d = dx("2100660101", { propertyName: "架空が丘4丁目A号棟", ownerName: "架空　次郎", address: "東京都架空区南町9-9-9" });
    expect(resolveDuplicates([s], [d]).removeIds.size).toBe(0);
  });

  it("住所がはっきり違えば消さずに要確認にする (同じ施主の2棟目)", () => {
    const s = sk("a", { ownerName: "架空　太郎", propertyName: "架空 太郎 様邸", address: "東京都架空区北町1-2-3" });
    const d = dx("1026880101", { ownerName: "架空　太郎", propertyName: "架空 太郎様邸", address: "神奈川県架空市南町4-5-6" });
    const result = resolveDuplicates([s], [d]);
    expect(result.removeIds.size).toBe(0);
    expect([...result.uncertainIds]).toEqual(["sk:a"]);
  });

  it("同じ敷地の3棟が台帳にも3棟あれば全部消す", () => {
    const at = (name: string, address: string) => ({ ownerName: "架空　太郎", propertyName: name, address });
    const suketto = [
      sk("a", at("架空町戸建A棟", "東京都架空区北町44-1")),
      sk("b", at("架空町戸建B棟", "東京都架空区北町44-1")),
      sk("c", at("架空町戸建C棟", "東京都架空区北町44-1")),
    ];
    const ledger = [
      dx("3100490101", at("架空町戸建新築計画A号棟", "東京都架空区北町44-1")),
      dx("3100490201", at("架空町戸建新築計画B号棟", "東京都架空区北町44-1")),
      dx("3100490301", at("架空町戸建新築計画C号棟", "東京都架空区北町44-1-3")),
    ];
    const result = resolveDuplicates(suketto, ledger);
    expect([...result.removeIds].sort()).toEqual(["sk:a", "sk:b", "sk:c"]);
  });

  it("台帳に無い棟は消さない (棟の記号が食い違うものは結び付けない)", () => {
    const at = (name: string) => ({ ownerName: "架空　太郎", propertyName: name, address: "東京都架空区北町44-1" });
    const suketto = [sk("a", at("架空町戸建A棟")), sk("x", at("架空町戸建X棟"))];
    const ledger = [
      dx("3100490101", at("架空町戸建A号棟")),
      dx("3100490201", at("架空町戸建B号棟")),
      dx("3100490301", at("架空町戸建C号棟")),
    ];
    const result = resolveDuplicates(suketto, ledger);
    // 助っ人2件 ≤ 台帳3件 だが、X棟は台帳に無いので消してはいけない
    expect([...result.removeIds]).toEqual(["sk:a"]);
    expect(result.uncertainIds.has("sk:x")).toBe(false);
  });

  it("棟の記号が無いまま台帳より棟数が多ければ、消さずに要確認にする", () => {
    const at = (n: string) => ({ ownerName: "架空　太郎", propertyName: `架空町共同住宅${n}`, address: "東京都架空区北町44-1" });
    const suketto = [sk("a", at("")), sk("b", at("")), sk("c", at(""))];
    const ledger = [dx("3100490101", at("")), dx("3100490201", at(""))];
    const result = resolveDuplicates(suketto, ledger);
    expect(result.removeIds.size).toBe(0);
    expect([...result.uncertainIds].sort()).toEqual(["sk:a", "sk:b", "sk:c"]);
  });

  it("台帳が空欄の項目だけを助っ人クラウドから補う", () => {
    const s = sk("a", {
      ownerName: "架空　太郎",
      address: "東京都架空区北町1-2-3",
      handoverDate: "2023/03/31",
      contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
      developer: "架空建設",
    });
    const d = dx("1012340101", {
      ownerName: "架空　太郎",
      address: "東京都架空区北町1-2-3",
      handoverDate: null,
      contacts: [],
      developer: "EU",
    });
    const values = resolveDuplicates([s], [d]).supplements.get("dx:1012340101");
    expect(values).toEqual({
      handoverDate: "2023/03/31",
      contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
    });
    // 台帳に値がある事業者は補完しない (台帳が正)
    expect(values).not.toHaveProperty("developer");
  });

  it("棟ごとに正しい相手から補う (A棟の引渡日がB号棟に入らない)", () => {
    const at = (name: string, handoverDate: string | null) => ({
      ownerName: "架空　太郎",
      propertyName: name,
      address: "東京都架空区北町44-1",
      handoverDate,
    });
    const suketto = [sk("a", at("架空町戸建A棟", "2023/01/01")), sk("b", at("架空町戸建B棟", "2023/06/20"))];
    const ledger = [
      dx("3100490101", at("架空町戸建A号棟", null)),
      dx("3100490201", at("架空町戸建B号棟", null)),
    ];
    const result = resolveDuplicates(suketto, ledger);
    expect(result.removeIds.size).toBe(2);
    expect(result.supplements.get("dx:3100490101")?.handoverDate).toBe("2023/01/01");
    expect(result.supplements.get("dx:3100490201")?.handoverDate).toBe("2023/06/20");
  });

  it("棟の記号が無く相手を1つに絞れないときは補完しない", () => {
    const at = (handoverDate: string | null) => ({
      ownerName: "架空　太郎",
      propertyName: "架空町共同住宅",
      address: "東京都架空区北町44-1",
      handoverDate,
    });
    const suketto = [sk("a", at("2023/01/01")), sk("b", at("2023/06/20"))];
    const ledger = [dx("3100490101", at(null)), dx("3100490201", at(null))];
    const result = resolveDuplicates(suketto, ledger);
    expect(result.removeIds.size).toBe(2);
    // どちらの引渡日か決められないので入れない
    expect(result.supplements.size).toBe(0);
  });

  it("どちらかが空なら何もしない", () => {
    expect(resolveDuplicates([], [dx("1012340101")]).removeIds.size).toBe(0);
    expect(resolveDuplicates([sk("a")], []).removeIds.size).toBe(0);
  });
});

describe("withSupplements", () => {
  it("取り込み値が空欄の項目だけ受け付ける", () => {
    const d = dx("1012340101", { handoverDate: null, developer: "EU" });
    const next = withSupplements(d, { handoverDate: "2023/03/31", developer: "架空建設" });
    expect(next.supplements).toEqual({ handoverDate: "2023/03/31" });
    expect(effectiveFields(next).developer).toBe("EU");
    expect(effectiveFields(next).handoverDate).toBe("2023/03/31");
  });

  it("補完より利用者の手直しが優先される", () => {
    const d = withSupplements(dx("1012340101", { handoverDate: null }), { handoverDate: "2023/03/31" });
    const edited: Customer = { ...d, edits: { handoverDate: "2024/01/01" } };
    expect(effectiveFields(edited).handoverDate).toBe("2024/01/01");
  });

  it("補完は検索キーにも入る", () => {
    const d = withSupplements(dx("1012340101", { contacts: [] }), {
      contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
    });
    expect(d.searchKey).toContain("09000001234");
  });

  it("変化が無ければ同じオブジェクトを返す", () => {
    const d = dx("1012340101");
    expect(withSupplements(d, {})).toBe(d);
  });
});

describe("withDuplicateIssue", () => {
  it("付け外しでき、変化が無ければ同じオブジェクトを返す", () => {
    const s = sk("a");
    const flagged = withDuplicateIssue(s, true);
    expect(flagged.issues).toEqual([{ field: null, message: DUPLICATE_ISSUE }]);
    expect(withDuplicateIssue(flagged, true)).toBe(flagged);
    expect(withDuplicateIssue(flagged, false).issues).toEqual([]);
    expect(withDuplicateIssue(s, false)).toBe(s);
  });
});
