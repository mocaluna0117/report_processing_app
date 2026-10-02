import { describe, expect, it } from "vitest";
import type { Customer, CustomerFields } from "@/lib/after/types";
import {
  type LedgerCustomer,
  type SharedLedger,
  extractLedger,
  ledgerCount,
  mergeSharedLedger,
  pickSharedLedger,
  sameLedgerSource,
  toCustomers,
} from "@/lib/shared/ledger";

// 顧客データの台帳そのものを2台で分け合う規則（2026-09-23）。
// ★これまでは xlsx / csv を置いて各自が取り込んでいた。差分ファイルが月ごとに溜まるので、
//   取り込んだあとの台帳を1つのファイルにする。
// ★**id は作り直さない。**取り込んだときに作って保存してある id をそのまま運ぶ。
//   助っ人クラウドの id は取り込み内容のハッシュなので、作り直すと手直しが結び付かなくなる。
// データはすべて架空（山田　太郎／架空　花子、PJ 21012301xx、電話 090-0000-xxxx）。

const fields = (over: Partial<CustomerFields> = {}): CustomerFields => ({
  pj: "2101230101",
  developer: "タカマツハウス",
  propertyName: "架空台1丁目 A号棟",
  ownerName: "山田　太郎",
  ownerKana: "ヤマダ　タロウ",
  postalCode: "",
  address: "東京都架空区北町1-2-3",
  contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
  emails: [],
  handoverDate: "2025/09/26",
  supervisor: "",
  salesRep: "",
  memo: "",
  ...over,
});

const customer = (id: string, source: Customer["source"], importedAt = 1): Customer => ({
  id,
  source,
  sourceKey: id.replace(/^(dx|sk):/, ""),
  sourceRow: 2,
  imported: fields(),
  edits: { memo: "この端末で直したメモ" },
  editStamps: { memo: 50 },
  issues: [],
  corporate: false,
  searchKey: "やまだたろう",
  importedAt,
  editedAt: 50,
});

const entry = (id: string, source: LedgerCustomer["source"], importedAt = 1): LedgerCustomer => ({
  id,
  source,
  sourceKey: id.replace(/^(dx|sk):/, ""),
  sourceRow: 2,
  imported: fields(),
  issues: [],
  corporate: false,
  importedAt,
});

const ledger = (over: SharedLedger): SharedLedger => over;

describe("この端末の台帳を取り出す", () => {
  it("取り込み元ごとに分け、id の順に並べる", () => {
    const out = extractLedger([
      customer("dx:2101230201", "dx", 10),
      customer("sk:aaaa", "suketto", 20),
      customer("dx:2101230101", "dx", 10),
    ]);
    expect(out.dx?.customers.map((c) => c.id)).toEqual(["dx:2101230101", "dx:2101230201"]);
    expect(out.suketto?.customers.map((c) => c.id)).toEqual(["sk:aaaa"]);
    expect(out.dx?.at).toBe(10);
    expect(out.suketto?.at).toBe(20);
  });

  it("★手直しは載せない（別のファイルで分け合うため）", () => {
    const out = extractLedger([customer("dx:2101230101", "dx")]);
    const json = JSON.stringify(out);
    expect(json).not.toContain("この端末で直したメモ");
    expect(json).not.toContain("editStamps");
  });

  it("★検索語も載せない（当てるときに作り直す）", () => {
    expect(JSON.stringify(extractLedger([customer("dx:2101230101", "dx")]))).not.toContain("searchKey");
  });

  it("その取り込み元の顧客がいなければ載せない", () => {
    expect(extractLedger([customer("dx:2101230101", "dx")]).suketto).toBeUndefined();
    expect(extractLedger([])).toEqual({});
  });
});

describe("突き合わせ（取り込み元で規則が違う）", () => {
  it("★点検保守台帳は足し込む（月ごとの差分を片方しか持っていなくても消えない）", () => {
    const a = ledger({ dx: { at: 10, customers: [entry("dx:2101230101", "dx", 10)] } });
    const b = ledger({ dx: { at: 20, customers: [entry("dx:2101230201", "dx", 20)] } });
    expect(mergeSharedLedger(a, b).dx?.customers.map((c) => c.id)).toEqual([
      "dx:2101230101",
      "dx:2101230201",
    ]);
  });

  it("点検保守台帳で同じ物件番号なら、あとから取り込んだ方を採る", () => {
    const old = { ...entry("dx:2101230101", "dx", 10), sourceKey: "ふるい" };
    const fresh = { ...entry("dx:2101230101", "dx", 20), sourceKey: "あたらしい" };
    const merged = mergeSharedLedger({ dx: { at: 10, customers: [old] } }, { dx: { at: 20, customers: [fresh] } });
    expect(merged.dx?.customers[0].sourceKey).toBe("あたらしい");
  });

  it("★助っ人クラウドは丸ごと入れ替え（和集合にすると、消したはずの行が戻ってくる）", () => {
    const a = ledger({ suketto: { at: 10, customers: [entry("sk:a", "suketto", 10), entry("sk:b", "suketto", 10)] } });
    const b = ledger({ suketto: { at: 20, customers: [entry("sk:a", "suketto", 20)] } });
    expect(mergeSharedLedger(a, b).suketto?.customers.map((c) => c.id)).toEqual(["sk:a"]);
  });

  it("片方にしか無い取り込み元は、そのまま残る", () => {
    const a = ledger({ dx: { at: 10, customers: [entry("dx:2101230101", "dx", 10)] } });
    const b = ledger({ suketto: { at: 20, customers: [entry("sk:a", "suketto", 20)] } });
    const merged = mergeSharedLedger(a, b);
    expect(ledgerCount(merged)).toBe(2);
  });

  it("★どちらが先でも同じ結果（可換）", () => {
    const a = ledger({
      dx: { at: 10, customers: [entry("dx:2101230101", "dx", 10)] },
      suketto: { at: 30, customers: [entry("sk:a", "suketto", 30)] },
    });
    const b = ledger({
      dx: { at: 20, customers: [entry("dx:2101230201", "dx", 20)] },
      suketto: { at: 10, customers: [entry("sk:b", "suketto", 10)] },
    });
    expect(mergeSharedLedger(a, b)).toEqual(mergeSharedLedger(b, a));
  });

  it("★何度重ねても変わらない（冪等）", () => {
    const a = ledger({ dx: { at: 10, customers: [entry("dx:2101230101", "dx", 10)] } });
    const b = ledger({ dx: { at: 20, customers: [entry("dx:2101230201", "dx", 20)] } });
    const once = mergeSharedLedger(a, b);
    expect(mergeSharedLedger(once, b)).toEqual(once);
    expect(mergeSharedLedger(once, once)).toEqual(once);
  });
});

describe("ファイルの読み方", () => {
  it("形の違う1件だけを落として、ほかは読む", () => {
    const raw = {
      dx: { at: 10, customers: [entry("dx:2101230101", "dx", 10), { id: "こわれている" }] },
    };
    expect(pickSharedLedger(raw)?.dx?.customers.map((c) => c.id)).toEqual(["dx:2101230101"]);
  });

  it("★まるごと形が違えば null（読めないファイルとして止める）", () => {
    expect(pickSharedLedger(null)).toBeNull();
    expect(pickSharedLedger([1])).toBeNull();
    expect(pickSharedLedger("文字列")).toBeNull();
  });

  it("知らない取り込み元は読み捨てる", () => {
    expect(pickSharedLedger({ unknown: { at: 1, customers: [] } })).toEqual({});
  });
});

describe("当てる形に戻す", () => {
  it("★id はそのまま運ぶ（作り直さない）", () => {
    const back = toCustomers({ at: 10, customers: [entry("sk:1a2b3c", "suketto", 10)] });
    expect(back[0].id).toBe("sk:1a2b3c");
    expect(back[0].imported.ownerName).toBe("山田　太郎");
  });

  it("手直しは空で戻す（当てるときに引き継がれる）", () => {
    const back = toCustomers({ at: 10, customers: [entry("dx:2101230101", "dx", 10)] });
    expect(back[0].edits).toEqual({});
    expect(back[0].editedAt).toBeNull();
  });

  it("中身が同じ取り込み元は、書き戻さずに済む", () => {
    const one = { at: 10, customers: [entry("dx:2101230101", "dx", 10)] };
    expect(sameLedgerSource(one, { at: 99, customers: [entry("dx:2101230101", "dx", 10)] })).toBe(true);
    expect(sameLedgerSource(one, { at: 10, customers: [] })).toBe(false);
    expect(sameLedgerSource(undefined, undefined)).toBe(true);
    expect(sameLedgerSource(one, undefined)).toBe(false);
  });
});

// 手入力で登録したお客様（2026-10-02）。元のファイルが無いので、2台目へ届く道は台帳だけ。
// 1件ずつ消せるので、消した印も一緒に運ぶ。
describe("手入力のお客様", () => {
  it("この端末の台帳に、手入力の分と消した印を載せる（消した id は載せない）", () => {
    const got = extractLedger(
      [customer("mn:a", "manual", 5), customer("mn:b", "manual", 7), customer("dx:1", "dx")],
      { "mn:b": 9, "mn:z": 3 },
    );
    expect(got.manual).toEqual({
      at: 5,
      customers: [entry("mn:a", "manual", 5)],
      deleted: { "mn:b": 9, "mn:z": 3 },
    });
    expect(got.dx?.customers.map((c) => c.id)).toEqual(["dx:1"]);
  });

  it("★2台で別々に登録しても両方残る（足し込む）", () => {
    const merged = mergeSharedLedger(
      ledger({ manual: { at: 1, customers: [entry("mn:a", "manual", 1)] } }),
      ledger({ manual: { at: 2, customers: [entry("mn:b", "manual", 2)] } }),
    );
    expect(merged.manual?.customers.map((c) => c.id)).toEqual(["mn:a", "mn:b"]);
  });

  it("★片方で消せば、もう片方にあっても落ちる（印は残る）", () => {
    const merged = mergeSharedLedger(
      ledger({ manual: { at: 1, customers: [entry("mn:a", "manual", 1), entry("mn:b", "manual", 1)] } }),
      ledger({ manual: { at: 0, customers: [], deleted: { "mn:a": 5 } } }),
    );
    expect(merged.manual).toEqual({
      at: 1,
      customers: [entry("mn:b", "manual", 1)],
      deleted: { "mn:a": 5 },
    });
  });

  it("★どちらが先でも同じ結果（可換）で、何度重ねても変わらない（冪等）", () => {
    const a = ledger({
      dx: { at: 1, customers: [entry("dx:1", "dx", 1)] },
      manual: { at: 3, customers: [entry("mn:a", "manual", 3), entry("mn:c", "manual", 1)], deleted: { "mn:x": 1 } },
    });
    const b = ledger({
      manual: { at: 4, customers: [entry("mn:b", "manual", 4)], deleted: { "mn:c": 6, "mn:x": 2 } },
    });
    const ab = mergeSharedLedger(a, b);
    expect(JSON.stringify(ab)).toBe(JSON.stringify(mergeSharedLedger(b, a)));
    expect(JSON.stringify(mergeSharedLedger(ab, b))).toBe(JSON.stringify(ab));
    expect(ab.manual?.customers.map((c) => c.id)).toEqual(["mn:a", "mn:b"]);
    expect(ab.manual?.deleted).toEqual({ "mn:c": 6, "mn:x": 2 });
  });

  it("ファイルから読む（消した印は手入力の分だけ。ほかの取り込み元の顧客が紛れていたら落とす）", () => {
    const got = pickSharedLedger({
      manual: {
        at: 1,
        customers: [entry("mn:a", "manual"), entry("dx:1", "dx")],
        deleted: { "mn:b": 2, "mn:c": "壊れた値" },
      },
      dx: { at: 1, customers: [entry("dx:1", "dx")], deleted: { "dx:1": 2 } },
    });
    expect(got?.manual).toEqual({ at: 1, customers: [entry("mn:a", "manual")], deleted: { "mn:b": 2 } });
    expect(got?.dx).toEqual({ at: 1, customers: [entry("dx:1", "dx")] });
  });

  it("件数に手入力の分も入る", () => {
    expect(
      ledgerCount(ledger({ dx: { at: 1, customers: [entry("dx:1", "dx")] }, manual: { at: 1, customers: [entry("mn:a", "manual")] } })),
    ).toBe(2);
  });
});

describe("当てる形に戻すときの検索語", () => {
  it("★取り込み値から作っておく（初めて届いた顧客が検索に掛からなかった）", () => {
    const [got] = toCustomers({ at: 1, customers: [entry("dx:1", "dx")] });
    expect(got.searchKey).toContain("ヤマダタロウ");
    expect(got.searchKey).toContain("2101230101");
  });
});
