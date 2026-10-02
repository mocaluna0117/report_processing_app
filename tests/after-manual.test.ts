import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAfterCase } from "@/lib/after/case";
import { effectiveFields, searchCustomers } from "@/lib/after/customer";
import {
  applySharedLedger,
  clearCustomers,
  countCustomers,
  deleteManualCustomer,
  loadCustomers,
  loadManualDeleted,
  loadSharedLedger,
  saveCustomerEdits,
  saveImport,
  saveManualCustomer,
} from "@/lib/after/customer-store";
import type { ParsedImport } from "@/lib/after/import";
import {
  type ManualDraft,
  createManualCustomer,
  developerFromPj,
  emptyManualDraft,
  findSamePj,
  isEmptyDraft,
  manualBlockedReason,
} from "@/lib/after/manual";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";
import { withoutCustomerEdits, isSharedCustomerEntry } from "@/lib/shared/customer-edits";
import { extractLedger } from "@/lib/shared/ledger";
import { SETTING_KEY_SHARED_MANUAL_DELETED, deleteMeta } from "@/lib/storage";

// 顧客データ (xlsx / csv) に無いお客様を、アフターの画面で手入力して登録する (2026-10-02)。
// データはすべて架空（山田　太郎／架空　花子、PJ 21012301xx、電話 090-0000-xxxx、example.com）。

const draft = (over: Partial<ManualDraft> = {}): ManualDraft => ({
  ...emptyManualDraft(),
  ownerName: "架空 花子",
  ...over,
});

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

const imported = (id: string, source: CustomerSource = "dx", over: Partial<CustomerFields> = {}): Customer => ({
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

const parsed = (source: "dx" | "suketto", customers: Customer[]): ParsedImport => ({
  source,
  fileName: "f.xlsx",
  sheetName: "Sheet1",
  customers,
  skipped: [],
  totalRows: customers.length,
});

describe("下書きからお客様を作る", () => {
  it("取り込みと同じ形に整える（氏名・カナ・郵便番号・引渡日・電話・PJ）", () => {
    const c = createManualCustomer(
      draft({
        pj: "２１０１２３０１９９",
        ownerName: "架空 花子",
        ownerKana: "かくう　はなこ",
        postalCode: "〒１２３４５６７",
        handoverDate: "令和7年9月26日",
        phones: ["09000001234（奥様）", ""],
        emails: [" hanako@example.com ", ""],
      }),
      "mn:1",
      100,
    );
    expect(c).toMatchObject({ id: "mn:1", source: "manual", sourceKey: "", importedAt: 100, edits: {} });
    expect(c.imported).toMatchObject({
      pj: "2101230199",
      ownerName: "架空　花子",
      ownerKana: "カクウ　ハナコ",
      postalCode: "123-4567",
      handoverDate: "2025/09/26",
      emails: ["hanako@example.com"],
    });
    // 区切りの無い番号は区切りを推測で入れるので、確からしさは取り込みと同じく「要確認」になる
    expect(c.imported.contacts).toEqual([
      { phone: "090-0000-1234", relation: "奥様", confidence: "warn" },
    ]);
  });

  it("空欄は未設定（PJ・事業者・引渡日は null、ほかは空）", () => {
    const c = createManualCustomer(draft(), "mn:1", 1);
    expect(c.imported).toMatchObject({
      pj: null,
      developer: null,
      handoverDate: null,
      postalCode: "",
      contacts: [],
      emails: [],
    });
  });

  it("★読めない郵便番号・引渡日は捨てずに打ったまま残す（要確認にはしない）", () => {
    const c = createManualCustomer(draft({ postalCode: "12-34", handoverDate: "9月末" }), "mn:1", 1);
    expect(c.imported.postalCode).toBe("12-34");
    expect(c.imported.handoverDate).toBe("9月末");
    expect(c.issues).toEqual([]);
  });

  it("法人名は法人として扱う（受付の行で社名の空白を変えない）", () => {
    expect(createManualCustomer(draft({ ownerName: "株式会社 架空商事" }), "mn:1", 1).corporate).toBe(true);
  });

  it("★氏名・電話・メールで探せる", () => {
    const c = createManualCustomer(
      draft({ phones: ["090-0000-5678", ""], emails: ["hanako@example.com", ""] }),
      "mn:1",
      1,
    );
    expect(searchCustomers([c], "架空 花子").total).toBe(1);
    expect(searchCustomers([c], "09000005678").total).toBe(1);
    expect(searchCustomers([c], "hanako@example").total).toBe(1);
  });

  it("そのまま受付の行を作れる", () => {
    const c = createManualCustomer(draft({ propertyName: "架空台2丁目 B号棟" }), "mn:1", 1);
    const row = createAfterCase({ id: "c-1", customer: c, inquiryText: "", summary: "", engine: null });
    expect(row).toMatchObject({ customerId: "mn:1", customerSource: "manual", ownerDisplay: "架空　花子" });
  });
});

describe("登録ボタンが押せるか", () => {
  it("お客様氏名が無いと押せない", () => {
    expect(manualBlockedReason(emptyManualDraft())).toContain("お客様氏名");
    expect(manualBlockedReason(draft({ ownerName: "　" }))).toContain("お客様氏名");
    expect(manualBlockedReason(draft())).toBeNull();
  });

  it("メールアドレスの形が違うと押せない（空欄はよい）", () => {
    expect(manualBlockedReason(draft({ emails: ["hanako@", ""] }))).toContain("hanako@");
    expect(manualBlockedReason(draft({ emails: ["", "hanako@example.com"] }))).toBeNull();
  });

  it("何も入れていない下書きか", () => {
    expect(isEmptyDraft(emptyManualDraft())).toBe(true);
    expect(isEmptyDraft({ ...emptyManualDraft(), phones: ["", "090"] })).toBe(false);
    expect(isEmptyDraft({ ...emptyManualDraft(), address: "　" })).toBe(true);
  });
});

describe("PJ から分かること", () => {
  it("事業者を PJ の頭2桁から補う（判定できなければ空）", () => {
    expect(developerFromPj("2101230101", "")).toBe("タカマツハウス");
    expect(developerFromPj("4101230101", "SECUREA架空台")).toBe("大和ハウス工業");
    expect(developerFromPj("4101230101", "架空台")).toBe("");
    expect(developerFromPj("", "")).toBe("");
  });

  it("★同じ PJ のお客様がもういれば見つける（全角で打っても）", () => {
    const customers = [imported("dx:2101230101")];
    expect(findSamePj(customers, "２１０１２３０１０１")?.id).toBe("dx:2101230101");
    expect(findSamePj(customers, "2101230102")).toBeNull();
    expect(findSamePj(customers, "")).toBeNull();
  });
});

describe("手入力のお客様の保存", () => {
  beforeEach(async () => {
    await clearCustomers();
    await deleteMeta(SETTING_KEY_SHARED_MANUAL_DELETED);
  });

  const manual = (id: string, over: Partial<ManualDraft> = {}, now = 10) =>
    createManualCustomer(draft(over), id, now);

  it("保存して読み戻せる。件数は手入力として数え、最終取り込みには入れない", async () => {
    await saveImport(parsed("dx", [imported("dx:1")]));
    await saveManualCustomer(manual("mn:1", {}, 999));
    expect((await loadCustomers()).map((c) => c.id).sort()).toEqual(["dx:1", "mn:1"]);
    const counts = await countCustomers();
    expect(counts.bySource).toEqual({ suketto: 0, dx: 1, manual: 1 });
    expect(counts.lastImportedAt).toBe(1);
  });

  it("★顧客データを取り込み直しても消えない（助っ人クラウドの入れ替えでも）", async () => {
    await saveManualCustomer(manual("mn:1"));
    await saveImport(parsed("suketto", [imported("sk:1", "suketto")]));
    await saveImport(parsed("suketto", []));
    await saveImport(parsed("dx", [imported("dx:1")]));
    expect((await loadCustomers()).map((c) => c.id).sort()).toEqual(["dx:1", "mn:1"]);
  });

  it("★取り込んだお客様と同じ物件でも、重複として消したり補ったりしない", async () => {
    const same = manual("mn:1", {
      pj: "2101230101",
      ownerName: "山田 太郎",
      propertyName: "架空台1丁目 A号棟",
      address: "東京都架空区北町1-2-3",
    });
    await saveManualCustomer(same);
    await saveImport(parsed("dx", [imported("dx:2101230101", "dx", { handoverDate: null })]));
    await saveImport(parsed("suketto", [imported("sk:1", "suketto")]));
    const got = (await loadCustomers()).find((c) => c.id === "mn:1");
    expect(got).toEqual(same);
  });

  it("手直しは取り込んだお客様と同じ道を通る（登録した内容に戻せる）", async () => {
    await saveManualCustomer(manual("mn:1"));
    const edited = await saveCustomerEdits("mn:1", { emails: ["hanako@example.com"] }, 50);
    expect(edited?.imported.emails).toEqual([]);
    expect(effectiveFields(edited!).emails).toEqual(["hanako@example.com"]);
  });

  it("消すと、消した印が残る（共有フォルダーへ運ぶため）", async () => {
    await saveManualCustomer(manual("mn:1"));
    await deleteManualCustomer("mn:1", 77);
    expect(await loadCustomers()).toEqual([]);
    expect(await loadManualDeleted()).toEqual({ "mn:1": 77 });
    expect((await loadSharedLedger()).manual).toEqual({ at: 0, customers: [], deleted: { "mn:1": 77 } });
  });

  it("★取り込んだお客様は消せない（ファイルを取り込み直すと戻るため）", async () => {
    await saveImport(parsed("dx", [imported("dx:1")]));
    await expect(deleteManualCustomer("dx:1")).rejects.toThrow();
    expect(await loadCustomers()).toHaveLength(1);
  });

  it("手入力のお客様は保存しかできない（ファイルの取り込みの道には入れない）", async () => {
    await expect(saveManualCustomer(imported("dx:1"))).rejects.toThrow();
  });
});

describe("共有フォルダーの台帳から手入力のお客様を当てる", () => {
  beforeEach(async () => {
    await clearCustomers();
    await deleteMeta(SETTING_KEY_SHARED_MANUAL_DELETED);
  });

  it("★この端末に無いお客様を足す（検索できる形で）", async () => {
    const theirs = createManualCustomer(draft({ ownerName: "架空 花子" }), "mn:1", 10);
    const reports = await applySharedLedger(extractLedger([theirs]));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: "manual", added: 1, removed: 0 });
    const got = await loadCustomers();
    expect(got.map((c) => c.id)).toEqual(["mn:1"]);
    expect(searchCustomers(got, "架空").total).toBe(1);
  });

  it("★この端末の手直しは残す", async () => {
    const c = createManualCustomer(draft(), "mn:1", 10);
    await saveManualCustomer(c);
    await saveCustomerEdits("mn:1", { address: "東京都架空区南町4-5-6" }, 50);
    await applySharedLedger(extractLedger([c]));
    expect(effectiveFields((await loadCustomers())[0]).address).toBe("東京都架空区南町4-5-6");
  });

  it("★相手で消したお客様は、この端末からも消え、印も受け取る", async () => {
    const c = createManualCustomer(draft(), "mn:1", 10);
    await saveManualCustomer(c);
    const reports = await applySharedLedger(extractLedger([], { "mn:1": 20 }));
    expect(reports[0]).toMatchObject({ removed: 1 });
    expect(await loadCustomers()).toEqual([]);
    expect(await loadManualDeleted()).toEqual({ "mn:1": 20 });
  });

  it("手入力の分が無い台帳なら、手入力のお客様には触らない", async () => {
    const c = createManualCustomer(draft(), "mn:1", 10);
    await saveManualCustomer(c);
    await applySharedLedger(extractLedger([imported("dx:1")]));
    expect((await loadCustomers()).map((x) => x.id).sort()).toEqual(["dx:1", "mn:1"]);
  });
});

describe("手入力のお客様の手直しを共有する", () => {
  const entry = {
    source: "manual",
    sourceKey: "",
    edits: { address: "東京都架空区南町4-5-6" },
    editStamps: { address: 50 },
    editedAt: 50,
  };

  it("★手直しのファイルで手入力のお客様を読み捨てない", () => {
    expect(isSharedCustomerEntry(entry)).toBe(true);
  });

  it("消したお客様の手直しを落とす（落とすものが無ければ同じ参照）", () => {
    const edits = { "mn:1": entry, "mn:2": entry } as Parameters<typeof withoutCustomerEdits>[0];
    expect(Object.keys(withoutCustomerEdits(edits, ["mn:1"]))).toEqual(["mn:2"]);
    expect(withoutCustomerEdits(edits, ["mn:9"])).toBe(edits);
  });
});
