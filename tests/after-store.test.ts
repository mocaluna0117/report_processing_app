import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAfterCase } from "@/lib/after/case";
import { applyEdits, effectiveFields } from "@/lib/after/customer";
import {
  clearCustomers,
  countCustomers,
  loadCustomers,
  saveCustomerEdits,
  saveImport,
} from "@/lib/after/customer-store";
import type { ParsedImport } from "@/lib/after/import";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";
import {
  clearAfterCases,
  clearAll,
  hasStoredData,
  loadAfterCases,
  saveAfterCases,
  saveFiles,
} from "@/lib/storage";

const fields = (over: Partial<CustomerFields> = {}): CustomerFields => ({
  pj: "2101230101",
  developer: "タカマツハウス",
  propertyName: "架空台1丁目 A号棟",
  ownerName: "山田　太郎",
  ownerKana: "ヤマダ　タロウ",
  address: "東京都架空区北町1-2-3",
  contacts: [{ phone: "090-0000-1234", relation: "", confidence: "ok" }],
  emails: [],
  handoverDate: "2025/09/26",
  salesRep: "",
  memo: "",
  ...over,
});

const customer = (
  id: string,
  source: CustomerSource = "dx",
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

const parsed = (source: CustomerSource, customers: Customer[]): ParsedImport => ({
  source,
  fileName: "f.xlsx",
  sheetName: "Sheet1",
  customers,
  skipped: [],
  totalRows: customers.length,
});

beforeEach(async () => {
  await clearAll();
  await clearCustomers();
  await clearAfterCases();
});

describe("顧客データの保存", () => {
  it("取り込んだ顧客を保存して読み戻せる", async () => {
    const report = await saveImport(parsed("dx", [customer("dx:1"), customer("dx:2")]));
    expect(report).toMatchObject({ added: 2, updated: 0, removed: 0 });
    expect(await loadCustomers()).toHaveLength(2);
    const counts = await countCustomers();
    expect(counts.total).toBe(2);
    expect(counts.bySource.dx).toBe(2);
  });

  it("点検保守台帳は同じPJを更新し、載っていない顧客は消さない", async () => {
    await saveImport(parsed("dx", [customer("dx:1"), customer("dx:2")]));
    const report = await saveImport(
      parsed("dx", [customer("dx:2", "dx", { developer: "賃貸住宅事業部" }), customer("dx:3")]),
    );
    expect(report).toMatchObject({ added: 1, updated: 1, removed: 0 });
    const all = await loadCustomers();
    expect(all).toHaveLength(3);
    expect(effectiveFields(all.find((c) => c.id === "dx:2")!).developer).toBe("賃貸住宅事業部");
  });

  it("助っ人クラウドは取り込み直すと入れ替える (載っていない行は消す)", async () => {
    await saveImport(parsed("suketto", [customer("sk:1", "suketto"), customer("sk:2", "suketto")]));
    const report = await saveImport(parsed("suketto", [customer("sk:1", "suketto")]));
    expect(report).toMatchObject({ added: 0, updated: 1, removed: 1 });
    expect((await loadCustomers()).map((c) => c.id)).toEqual(["sk:1"]);
  });

  it("入れ替えても別の取り込み元 (点検保守台帳) の顧客は消さない", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    await saveImport(parsed("suketto", [customer("sk:1", "suketto")]));
    await saveImport(parsed("suketto", []));
    expect((await loadCustomers()).map((c) => c.id)).toEqual(["dx:1"]);
  });

  it("再取込しても利用者の修正が残る", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    await saveCustomerEdits("dx:1", { developer: "大和ハウス工業" }, 100);
    const report = await saveImport(parsed("dx", [customer("dx:1")]));
    expect(report.editsPreserved).toBe(1);
    const saved = (await loadCustomers())[0];
    expect(effectiveFields(saved).developer).toBe("大和ハウス工業");
  });

  it("修正は取り込み値と別に保持される (取り込み値に戻せる)", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    const edited = await saveCustomerEdits("dx:1", { propertyName: "手入力した物件名" }, 100);
    expect(edited?.imported.propertyName).toBe("架空台1丁目 A号棟");
    expect(edited?.edits.propertyName).toBe("手入力した物件名");
  });

  it("件数が多くても1回のまとめ書きで保存できる", async () => {
    const many = Array.from({ length: 500 }, (_, i) => customer(`dx:${i}`));
    await saveImport(parsed("dx", many));
    expect((await countCustomers()).total).toBe(500);
  });

  it("削除ボタンで全件消える", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    await clearCustomers();
    expect(await loadCustomers()).toHaveLength(0);
  });
});

describe("受付一覧の保存", () => {
  const makeCase = (id: string) =>
    createAfterCase({
      id,
      customer: customer("dx:1"),
      inquiryText: "換気扇から異音",
      summary: "浴室の換気扇から異音",
      engine: "gemini",
      now: new Date("2026-08-30T02:00:00Z"),
    });

  it("保存して読み戻せる", async () => {
    await saveAfterCases([makeCase("c-1"), makeCase("c-2")]);
    const loaded = await loadAfterCases();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].kind).toBe("after");
    expect(loaded[0].inquiryText).toBe("換気扇から異音");
    expect(loaded[0].report.categories.after).toBe(true);
  });

  it("空配列では既存を消さない (復元前の上書き防止)", async () => {
    await saveAfterCases([makeCase("c-1")]);
    await saveAfterCases([]);
    expect(await loadAfterCases()).toHaveLength(1);
  });

  it("「受付一覧を消去」で消える", async () => {
    await saveAfterCases([makeCase("c-1")]);
    await clearAfterCases();
    expect(await loadAfterCases()).toHaveLength(0);
  });
});

describe("定期点検の「保存データを消去」との切り分け", () => {
  it("顧客データと受付一覧は残す", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    await saveAfterCases([
      createAfterCase({
        id: "c-1",
        customer: customer("dx:1"),
        inquiryText: "x",
        summary: "y",
        engine: "rule",
      }),
    ]);
    await clearAll();
    expect(await loadCustomers()).toHaveLength(1);
    expect(await loadAfterCases()).toHaveLength(1);
  });

  it("顧客データ・受付一覧だけでは「保存データあり」と数えない", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    await saveAfterCases([
      createAfterCase({
        id: "c-1",
        customer: customer("dx:1"),
        inquiryText: "x",
        summary: "y",
        engine: "rule",
      }),
    ]);
    expect(await hasStoredData()).toBe(false);
    // 定期点検のPDFがあれば数える
    await saveFiles([
      { id: "f-1", name: "a.pdf", file: new File([new Uint8Array([1])], "a.pdf") },
    ]);
    expect(await hasStoredData()).toBe(true);
  });
});

describe("applyEdits", () => {
  it("修正した項目だけを差分として持つ", () => {
    const edited = applyEdits(customer("dx:1"), { developer: "大和ハウス工業" }, 5);
    expect(edited.edits).toEqual({ developer: "大和ハウス工業" });
    expect(edited.editedAt).toBe(5);
  });
});
