import { describe, expect, it } from "vitest";
import { applyEdits, effectiveFields, resetEdits } from "@/lib/after/customer";
import type { Customer, CustomerFields } from "@/lib/after/types";
import {
  type SharedCustomerEntry,
  applySharedCustomerEdits,
  extractCustomerEdits,
  mergeCustomerEdits,
  mergeCustomerEntry,
  pickSharedCustomerEdits,
  withSharedEntry,
} from "@/lib/shared/customer-edits";

// 2台の手直しを突き合わせる規則（2026-09-22）。
// ★どちらが先でも同じ結果（可換）・何度重ねても変わらない（冪等）。
//   書き負けても次の同期で相手の分が戻るので、ロックを持たない設計の土台。
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

const customer = (id = "dx:2101230101", over: Partial<CustomerFields> = {}): Customer => ({
  id,
  source: "dx",
  sourceKey: id.replace("dx:", ""),
  sourceRow: 2,
  imported: fields(over),
  edits: {},
  issues: [],
  corporate: false,
  searchKey: "",
  importedAt: 1,
  editedAt: null,
});

const entry = (over: Partial<SharedCustomerEntry> = {}): SharedCustomerEntry => ({
  source: "dx",
  sourceKey: "2101230101",
  edits: {},
  editStamps: {},
  editedAt: 0,
  ...over,
});

describe("手直しを取り出す", () => {
  it("何も直していない顧客は載せない", () => {
    expect(extractCustomerEdits([customer()])).toEqual({});
  });

  it("直した顧客だけを、項目ごとの印つきで載せる", () => {
    const edited = applyEdits(customer(), { memo: "架空のメモ" }, 5);
    expect(extractCustomerEdits([customer("dx:2101230102"), edited])).toEqual({
      "dx:2101230101": {
        source: "dx",
        sourceKey: "2101230101",
        edits: { memo: "架空のメモ" },
        editStamps: { memo: 5 },
        editedAt: 5,
      },
    });
  });

  it("★印の無い古いデータは editedAt を印とみなして載せる（手直しを落とさない）", () => {
    const { editStamps: _drop, ...old } = applyEdits(customer(), { memo: "古い手直し" }, 7);
    const shared = extractCustomerEdits([old]);
    expect(shared["dx:2101230101"].editStamps).toEqual({ memo: 7 });
  });

  it("出どころの記録だけがある顧客も載せる（引渡日・監督の反映）", () => {
    const withSync: Customer = { ...customer(), reportSync: { handoverDate: "2025/09/26", at: 3, pj: "2101230101" } };
    expect(Object.keys(extractCustomerEdits([withSync]))).toEqual(["dx:2101230101"]);
  });
});

describe("1件の突き合わせ", () => {
  it("★項目ごとに新しい方を採る（別の項目を直していたら両方残る）", () => {
    const a = entry({ edits: { memo: "Aのメモ" }, editStamps: { memo: 10 }, editedAt: 10 });
    const b = entry({ edits: { supervisor: "架空　花子" }, editStamps: { supervisor: 20 }, editedAt: 20 });
    expect(mergeCustomerEntry(a, b)).toEqual(
      entry({
        edits: { memo: "Aのメモ", supervisor: "架空　花子" },
        editStamps: { memo: 10, supervisor: 20 },
        editedAt: 20,
      }),
    );
  });

  it("同じ項目なら新しい方が勝つ", () => {
    const a = entry({ edits: { memo: "古い" }, editStamps: { memo: 10 }, editedAt: 10 });
    const b = entry({ edits: { memo: "新しい" }, editStamps: { memo: 20 }, editedAt: 20 });
    expect(mergeCustomerEntry(a, b).edits).toEqual({ memo: "新しい" });
    expect(mergeCustomerEntry(b, a).edits).toEqual({ memo: "新しい" });
  });

  it("★印だけあって値が無いキーは「取り込み値に戻した」＝相手の古い手直しを消す", () => {
    const a = entry({ edits: { memo: "残したい" }, editStamps: { memo: 10 }, editedAt: 10 });
    const reverted = entry({ edits: {}, editStamps: { memo: 20 }, editedAt: 20 });
    const merged = mergeCustomerEntry(a, reverted);
    expect(merged.edits).toEqual({});
    expect(merged.editStamps).toEqual({ memo: 20 });
  });

  it("戻したより新しく直し直したら、その値が残る", () => {
    const reverted = entry({ edits: {}, editStamps: { memo: 10 }, editedAt: 10 });
    const again = entry({ edits: { memo: "直し直した" }, editStamps: { memo: 30 }, editedAt: 30 });
    expect(mergeCustomerEntry(reverted, again).edits).toEqual({ memo: "直し直した" });
  });

  it("★同時刻に並んだら、値がある方を採る（再取込で印が残ったときに相手の手直しを消さない）", () => {
    // mergeImported は台帳が追いついたキーの印を押し直さないので、この形が起きる
    const caughtUp = entry({ edits: {}, editStamps: { developer: 10 }, editedAt: 10 });
    const stillEdited = entry({ edits: { developer: "大和" }, editStamps: { developer: 10 }, editedAt: 10 });
    expect(mergeCustomerEntry(caughtUp, stillEdited).edits).toEqual({ developer: "大和" });
    expect(mergeCustomerEntry(stillEdited, caughtUp).edits).toEqual({ developer: "大和" });
  });

  it("出どころの記録は新しい方。片方にしか無ければ残す", () => {
    const a = entry({ reportSync: { handoverDate: "2025/01/01", at: 10, pj: "2101230101" } });
    const b = entry({ reportSync: { handoverDate: "2025/09/26", at: 20, pj: "2101230101" } });
    expect(mergeCustomerEntry(a, b).reportSync?.handoverDate).toBe("2025/09/26");
    expect(mergeCustomerEntry(entry(), b).reportSync?.at).toBe(20);
  });
});

describe("★どちらが先でも同じ結果になり、重ねても変わらない", () => {
  const a: SharedCustomerEntry = entry({
    edits: { memo: "Aのメモ", supervisor: "架空　花子" },
    editStamps: { memo: 10, supervisor: 15, developer: 12 },
    editedAt: 15,
    tenmatsuSync: { supervisor: "架空　花子", at: 15, pj: "2101230101" },
  });
  const b: SharedCustomerEntry = entry({
    edits: { memo: "Bのメモ", salesRep: "山田　太郎" },
    editStamps: { memo: 20, salesRep: 5 },
    editedAt: 20,
    reportSync: { handoverDate: "2025/09/26", at: 9, pj: "2101230101" },
  });

  it("可換（a→b と b→a が同じ）", () => {
    expect(mergeCustomerEntry(a, b)).toEqual(mergeCustomerEntry(b, a));
  });

  it("冪等（同じものを何度重ねても変わらない）", () => {
    const once = mergeCustomerEntry(a, b);
    expect(mergeCustomerEntry(once, b)).toEqual(once);
    expect(mergeCustomerEntry(once, a)).toEqual(once);
    expect(mergeCustomerEntry(once, once)).toEqual(once);
  });

  it("束でも可換・冪等（id の和集合）", () => {
    const left = { "dx:2101230101": a, "dx:2101230102": b };
    const right = { "dx:2101230101": b, "dx:2101230103": a };
    expect(mergeCustomerEdits(left, right)).toEqual(mergeCustomerEdits(right, left));
    const once = mergeCustomerEdits(left, right);
    expect(mergeCustomerEdits(once, right)).toEqual(once);
    expect(Object.keys(once)).toEqual(["dx:2101230101", "dx:2101230102", "dx:2101230103"]);
  });
});

describe("顧客に当てる", () => {
  it("手直しが付き、検索キーも作り直される", () => {
    const shared = extractCustomerEdits([applyEdits(customer(), { ownerName: "架空　花子" }, 5)]);
    const applied = withSharedEntry(customer(), shared["dx:2101230101"]);
    expect(effectiveFields(applied).ownerName).toBe("架空　花子");
    expect(applied.searchKey).toContain("架空");
    expect(applied.editStamps).toEqual({ ownerName: 5 });
  });

  it("★取り込み値と同じになった項目は修正から外す（台帳が追いついたとき）", () => {
    const shared = entry({ edits: { developer: "タカマツハウス" }, editStamps: { developer: 5 }, editedAt: 5 });
    // 台帳の値と同じなので、修正としては持たない
    expect(withSharedEntry(customer(), shared).edits).toEqual({});
  });

  it("★中身が変わらなければ同じ参照を返す（写しを書き直さずに済む）", () => {
    const edited = applyEdits(customer(), { memo: "同じ" }, 5);
    const shared = extractCustomerEdits([edited]);
    expect(withSharedEntry(edited, shared["dx:2101230101"])).toBe(edited);
  });

  it("戻した印だけの手直しを当てると、その項目が取り込み値に戻る", () => {
    const edited = applyEdits(customer(), { memo: "消される" }, 5);
    const reverted = entry({ edits: {}, editStamps: { memo: 9 }, editedAt: 9 });
    expect(withSharedEntry(edited, reverted).edits).toEqual({});
  });

  it("取り込み値に戻したものを取り出して当て直しても、戻ったまま（冪等）", () => {
    const edited = applyEdits(customer(), { memo: "あとで戻す" }, 5);
    const reset = resetEdits(edited, 9);
    const shared = extractCustomerEdits([reset]);
    expect(withSharedEntry(edited, shared["dx:2101230101"]).edits).toEqual({});
  });
});

describe("一覧に当てる", () => {
  it("当たった数と、この端末に無い手直しを返す", () => {
    const shared = {
      "dx:2101230101": entry({ edits: { memo: "当たる" }, editStamps: { memo: 5 }, editedAt: 5 }),
      "sk:ffffffff": entry({ source: "suketto", sourceKey: "9999", edits: { memo: "相手にしか無い顧客" }, editStamps: { memo: 5 }, editedAt: 5 }),
    };
    const result = applySharedCustomerEdits([customer(), customer("dx:2101230102")], shared);
    expect(result.changed).toBe(1);
    // ★見つからない手直しは捨てない（同じ xlsx を取り込めば結び付く）
    expect(result.unmatched).toEqual(["sk:ffffffff"]);
    expect(effectiveFields(result.customers[0]).memo).toBe("当たる");
    expect(result.customers[1]).toBe(result.customers[1]);
  });

  it("当たるものが無ければ、顧客はそのまま", () => {
    const list = [customer()];
    const result = applySharedCustomerEdits(list, {});
    expect(result.changed).toBe(0);
    expect(result.customers[0]).toBe(list[0]);
  });
});

describe("形の違うファイルの読み方", () => {
  it("形の違う1件だけを落として、ほかは読む", () => {
    const raw = {
      "dx:2101230101": entry({ edits: { memo: "生きている" }, editStamps: { memo: 5 }, editedAt: 5 }),
      "dx:bad": { edits: "文字列" },
      "dx:bad2": null,
    };
    expect(Object.keys(pickSharedCustomerEdits(raw))).toEqual(["dx:2101230101"]);
  });

  it("そもそも形が違えば空として読む", () => {
    expect(pickSharedCustomerEdits(null)).toEqual({});
    expect(pickSharedCustomerEdits([1, 2])).toEqual({});
  });
});
