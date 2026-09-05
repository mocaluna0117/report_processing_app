import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAfterCase } from "@/lib/after/case";
import { PROPERTY_COUNT_COL, PROPERTY_COUNT_MARK } from "@/lib/tsv";
import { applyEdits, effectiveFields, isReportHandover } from "@/lib/after/customer";
import {
  clearCustomers,
  countCustomers,
  loadCustomers,
  saveCustomerEdits,
  saveImport,
  saveReportHandoverDates,
} from "@/lib/after/customer-store";
import { DUPLICATE_ISSUE } from "@/lib/after/dedup";
import {
  clearStoredExamples,
  deleteStoredExample,
  loadExamples,
  mergeStoredExamples,
  upsertStoredExample,
} from "@/lib/examples-store";
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

/** 既定の fixture と重ならない別物件 (重複判定に引っかからないようにする) */
const OTHER_PROPERTY: Partial<CustomerFields> = {
  pj: "2109990101",
  propertyName: "架空谷9丁目 Z号棟",
  ownerName: "架空　次郎",
  address: "北海道架空市南町9-9-9",
};

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
  await clearStoredExamples("inquiry");
  await clearStoredExamples("inspection");
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
    // 重複と判定されないよう、別の物件にしておく
    await saveImport(parsed("suketto", [customer("sk:1", "suketto", OTHER_PROPERTY)]));
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

// 「点検保守台帳 (DX) を正とし、同じ物件の助っ人クラウドは消す」
describe("取り込み元をまたいだ重複の解消", () => {
  /** 同じ物件を指す2件 (助っ人クラウドには引渡日があり、台帳には無い) */
  const pair = () => ({
    suketto: customer("sk:1", "suketto", { pj: null, handoverDate: "2023/03/31" }),
    dx: customer("dx:1", "dx", { handoverDate: null }),
  });

  it("点検保守台帳を後から取り込むと、重複した助っ人クラウドを消す", async () => {
    const { suketto, dx } = pair();
    await saveImport(parsed("suketto", [suketto]));
    const report = await saveImport(parsed("dx", [dx]));
    expect(report).toMatchObject({ added: 1, dedupRemoved: 1, supplemented: 1 });
    expect((await loadCustomers()).map((c) => c.id)).toEqual(["dx:1"]);
  });

  it("助っ人クラウドを後から取り込むと、重複した行は取り込まない", async () => {
    const { suketto, dx } = pair();
    await saveImport(parsed("dx", [dx]));
    const report = await saveImport(parsed("suketto", [suketto]));
    expect(report).toMatchObject({ added: 0, dedupRemoved: 1, supplemented: 1 });
    expect((await loadCustomers()).map((c) => c.id)).toEqual(["dx:1"]);
  });

  it("台帳の空欄 (引渡日) を助っ人クラウドから補う", async () => {
    const { suketto, dx } = pair();
    await saveImport(parsed("suketto", [suketto]));
    await saveImport(parsed("dx", [dx]));
    const saved = (await loadCustomers())[0];
    expect(saved.imported.handoverDate).toBeNull();
    expect(effectiveFields(saved).handoverDate).toBe("2023/03/31");
  });

  it("元の助っ人クラウドが消えた後に取り込み直しても補完が残る", async () => {
    const { suketto, dx } = pair();
    await saveImport(parsed("suketto", [suketto]));
    await saveImport(parsed("dx", [dx]));
    // 台帳だけをもう一度取り込む (補完のもとになった助っ人クラウドの行はもう無い)
    await saveImport(parsed("dx", [customer("dx:1", "dx", { handoverDate: null })]));
    expect(effectiveFields((await loadCustomers())[0]).handoverDate).toBe("2023/03/31");
  });

  it("台帳に引渡日が入ったら補完は外れる (台帳が正)", async () => {
    const { suketto, dx } = pair();
    await saveImport(parsed("suketto", [suketto]));
    await saveImport(parsed("dx", [dx]));
    await saveImport(parsed("dx", [customer("dx:1", "dx", { handoverDate: "2024/01/15" })]));
    const saved = (await loadCustomers())[0];
    expect(saved.supplements?.handoverDate).toBeUndefined();
    expect(effectiveFields(saved).handoverDate).toBe("2024/01/15");
  });

  it("取り込み順を変えても同じ結果になる", async () => {
    const snapshot = async () =>
      (await loadCustomers())
        .map((c) => `${c.id}:${JSON.stringify(effectiveFields(c))}`)
        .sort()
        .join("\n");
    const { suketto, dx } = pair();
    await saveImport(parsed("suketto", [suketto]));
    await saveImport(parsed("dx", [dx]));
    const first = await snapshot();

    await clearCustomers();
    await saveImport(parsed("dx", [pair().dx]));
    await saveImport(parsed("suketto", [pair().suketto]));
    expect(await snapshot()).toBe(first);
  });

  it("重複か決め切れないもの (住所が違う) は消さずに要確認にする", async () => {
    const suketto = customer("sk:1", "suketto", { pj: null, address: "北海道架空市南町9-9-9" });
    const report = await saveImport(parsed("suketto", [suketto]));
    expect(report.dedupUncertain).toBe(0);
    const after = await saveImport(parsed("dx", [customer("dx:1")]));
    expect(after).toMatchObject({ dedupRemoved: 0, dedupUncertain: 1 });
    const kept = (await loadCustomers()).find((c) => c.id === "sk:1");
    expect(kept?.issues.map((i) => i.message)).toContain(DUPLICATE_ISSUE);
  });

  it("台帳側が消えたら重複の知らせも消える", async () => {
    const suketto = customer("sk:1", "suketto", { pj: null, address: "北海道架空市南町9-9-9" });
    await saveImport(parsed("suketto", [suketto]));
    await saveImport(parsed("dx", [customer("dx:1")]));
    await clearCustomers();
    await saveImport(parsed("suketto", [suketto]));
    const kept = (await loadCustomers())[0];
    expect(kept.issues).toHaveLength(0);
  });

  it("台帳側が「×使用禁止×」で落ちた顧客が、助っ人クラウド側に残る", async () => {
    // 台帳の行は「×使用禁止×」で取り込まれず、助っ人クラウドの行は管理IDが「DX」。
    // どちらも相手に譲ると顧客が1件も残らなくなるので、助っ人クラウド側は落とさない
    const orphan = customer("sk:1", "suketto", { pj: null, ...OTHER_PROPERTY });
    const report = await saveImport(parsed("suketto", [orphan]));
    expect(report.dedupRemoved).toBe(0);
    await saveImport(parsed("dx", [customer("dx:1")]));
    expect((await loadCustomers()).map((c) => c.id).sort()).toEqual(["dx:1", "sk:1"]);
  });

  it("重複していない顧客はどちらの取り込み元でも残る", async () => {
    await saveImport(parsed("dx", [customer("dx:1")]));
    await saveImport(parsed("suketto", [customer("sk:1", "suketto", OTHER_PROPERTY)]));
    const report = await saveImport(parsed("dx", [customer("dx:1")]));
    expect(report.dedupRemoved).toBe(0);
    expect((await loadCustomers()).map((c) => c.id).sort()).toEqual(["dx:1", "sk:1"]);
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
    expect(loaded[0].cells[PROPERTY_COUNT_COL]).toBe(PROPERTY_COUNT_MARK);
  });

  it("物件数が空欄の古い受付は読み込み時に★で埋める", async () => {
    // ★を扱う前に保存された受付 (印を持たない)
    const { propertyCountMarked: _mark, ...old } = makeCase("c-old");
    await saveAfterCases([
      { ...old, cells: old.cells.map((v, i) => (i === PROPERTY_COUNT_COL ? "" : v)) },
    ]);
    const [loaded] = await loadAfterCases();
    expect(loaded.cells[PROPERTY_COUNT_COL]).toBe(PROPERTY_COUNT_MARK);
  });

  it("利用者が消した★は再読み込みで戻らない", async () => {
    const row = makeCase("c-cleared");
    await saveAfterCases([
      { ...row, cells: row.cells.map((v, i) => (i === PROPERTY_COUNT_COL ? "" : v)) },
    ]);
    const [loaded] = await loadAfterCases();
    expect(loaded.cells[PROPERTY_COUNT_COL]).toBe("");
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

describe("学習した書き方の保存", () => {
  const example = (id: string, output = "浴室の換気扇から異音", updatedAt = 1_000) => ({
    id,
    input: "（お客様）より入電。浴室の換気扇から異音",
    output,
    createdAt: 1_000,
    updatedAt,
  });

  it("学習を保存して読み戻せる", async () => {
    await upsertStoredExample("inquiry", example("c-1"));
    await upsertStoredExample("inquiry", example("c-2"));
    const saved = await loadExamples("inquiry");
    expect(saved).toHaveLength(2);
    expect(saved.map((e) => e.id)).toEqual(["c-1", "c-2"]);
  });

  it("同じ受付を学習し直すと差し替わる", async () => {
    await upsertStoredExample("inquiry", example("c-1"));
    await upsertStoredExample("inquiry", example("c-1", "直した本文", 2_000));
    const saved = await loadExamples("inquiry");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ output: "直した本文", createdAt: 1_000, updatedAt: 2_000 });
  });

  it("1件だけ消せる / 最後の1件も消せる", async () => {
    await upsertStoredExample("inquiry", example("c-1"));
    await upsertStoredExample("inquiry", example("c-2"));
    expect(await deleteStoredExample("inquiry", "c-1")).toHaveLength(1);
    expect(await loadExamples("inquiry")).toHaveLength(1);
    await deleteStoredExample("inquiry", "c-2");
    expect(await loadExamples("inquiry")).toEqual([]);
  });

  it("書き出したものを取り込める (同じ id は新しい方)", async () => {
    await upsertStoredExample("inquiry", example("c-1", "古い本文", 1_000));
    await mergeStoredExamples("inquiry", [
      example("c-1", "新しい本文", 3_000),
      example("c-9", "別の受付", 3_000),
    ]);
    const saved = await loadExamples("inquiry");
    expect(saved).toHaveLength(2);
    expect(saved.find((e) => e.id === "c-1")?.output).toBe("新しい本文");
  });

  it("「保存データを消去」「受付一覧を消去」では消えない (設定扱い)", async () => {
    await upsertStoredExample("inquiry", example("c-1"));
    await clearAfterCases();
    await clearAll();
    expect(await loadExamples("inquiry")).toHaveLength(1);
    // 学習だけがある状態では「前回の内容」とはみなさない
    expect(await hasStoredData()).toBe(false);
  });

  it("定期点検とアフターの手本は別に持つ", async () => {
    await upsertStoredExample("inquiry", example("c-1", "アフターの本文"));
    await upsertStoredExample("inspection", example("p-1", "点検の本文"));
    expect((await loadExamples("inquiry")).map((e) => e.output)).toEqual(["アフターの本文"]);
    expect((await loadExamples("inspection")).map((e) => e.output)).toEqual(["点検の本文"]);
    // 片方を消しても、もう片方は残る
    await clearStoredExamples("inquiry");
    expect(await loadExamples("inquiry")).toEqual([]);
    expect(await loadExamples("inspection")).toHaveLength(1);
  });

  it("すべて消去できる", async () => {
    await upsertStoredExample("inquiry", example("c-1"));
    await clearStoredExamples("inquiry");
    expect(await loadExamples("inquiry")).toEqual([]);
  });

  it("受付の伏せ字メモも保存・復元される", async () => {
    const row = createAfterCase({
      id: "c-1",
      customer: customer("dx:1"),
      inquiryText: "原文のメモ",
      redactedInquiry: "伏せ字のメモ",
      summary: "浴室の換気扇から異音",
      engine: "gemini",
    });
    await saveAfterCases([row]);
    const [loaded] = await loadAfterCases();
    expect(loaded.redactedInquiry).toBe("伏せ字のメモ");
    expect(loaded.originalSummary).toBe("浴室の換気扇から異音");
  });
});

describe("報告書の引渡日の反映", () => {
  it("修正として書き、出どころを残す", async () => {
    await saveImport(parsed("dx", [customer("dx:1", "dx", { handoverDate: null })]));
    const saved = await saveReportHandoverDates([
      { id: "dx:1", date: "2025/09/26", pj: "2101230101" },
    ]);
    expect(saved).toHaveLength(1);
    const [stored] = await loadCustomers();
    expect(effectiveFields(stored).handoverDate).toBe("2025/09/26");
    expect(stored.edits.handoverDate).toBe("2025/09/26");
    expect(stored.reportSync).toMatchObject({ handoverDate: "2025/09/26", pj: "2101230101" });
    expect(isReportHandover(stored)).toBe(true);
  });

  it("見つからないIDは飛ばし、複数件を1回で書ける", async () => {
    await saveImport(
      parsed("dx", [
        customer("dx:1", "dx", { handoverDate: null }),
        customer("dx:2", "dx", { ...OTHER_PROPERTY, handoverDate: null }),
      ]),
    );
    const saved = await saveReportHandoverDates([
      { id: "dx:1", date: "2025/09/26", pj: "2101230101" },
      { id: "dx:2", date: "2024/04/01", pj: "2109990101" },
      { id: "dx:missing", date: "2020/01/01", pj: null },
    ]);
    expect(saved).toHaveLength(2);
    const stored = await loadCustomers();
    expect(stored.map((c) => effectiveFields(c).handoverDate).sort()).toEqual([
      "2024/04/01",
      "2025/09/26",
    ]);
  });

  it("顧客データを取り込み直しても残る", async () => {
    const imported = () => parsed("dx", [customer("dx:1", "dx", { handoverDate: null })]);
    await saveImport(imported());
    await saveReportHandoverDates([{ id: "dx:1", date: "2025/09/26", pj: "2101230101" }]);
    const report = await saveImport(imported());
    expect(report.editsPreserved).toBe(1);
    const [stored] = await loadCustomers();
    expect(effectiveFields(stored).handoverDate).toBe("2025/09/26");
    expect(isReportHandover(stored)).toBe(true);
  });

  it("取り込んだ値が同じになれば修正は外れ、出どころの表示も消える", async () => {
    await saveImport(parsed("dx", [customer("dx:1", "dx", { handoverDate: null })]));
    await saveReportHandoverDates([{ id: "dx:1", date: "2025/09/26", pj: "2101230101" }]);
    await saveImport(parsed("dx", [customer("dx:1", "dx", { handoverDate: "2025/09/26" })]));
    const [stored] = await loadCustomers();
    expect(stored.edits.handoverDate).toBeUndefined();
    expect(effectiveFields(stored).handoverDate).toBe("2025/09/26");
    expect(isReportHandover(stored)).toBe(false);
  });

  it("元に戻すと取り込んだ値に戻る", async () => {
    await saveImport(parsed("dx", [customer("dx:1", "dx", { handoverDate: "2024/04/01" })]));
    await saveReportHandoverDates([{ id: "dx:1", date: "2025/09/26", pj: "2101230101" }]);
    await saveCustomerEdits("dx:1", { handoverDate: "2024/04/01" });
    const [stored] = await loadCustomers();
    expect(stored.edits.handoverDate).toBeUndefined();
    expect(effectiveFields(stored).handoverDate).toBe("2024/04/01");
    expect(isReportHandover(stored)).toBe(false);
  });
});

describe("項目を増やす前に保存された顧客", () => {
  beforeEach(async () => {
    await clearCustomers();
  });

  /** 郵便番号・監督を持たない、古い形のレコードをそのまま書き込む */
  const putOldCustomer = async () => {
    const old = customer("dx:2101230101");
    const imported = { ...old.imported } as Record<string, unknown>;
    delete imported.postalCode;
    delete imported.supervisor;
    await saveImport({
      source: "dx",
      fileName: "old.xlsx",
      sheetName: "Sheet1",
      totalRows: 1,
      customers: [{ ...old, imported: imported as CustomerFields }],
      skipped: [],
    } satisfies ParsedImport);
  };

  it("★読み出すときに空欄で埋める (undefined のままにしない)", async () => {
    await putOldCustomer();
    const [got] = await loadCustomers();
    expect(effectiveFields(got).postalCode).toBe("");
    expect(effectiveFields(got).supervisor).toBe("");
  });

  it("★検索キーに \"undefined\" が焼き付かない", async () => {
    await putOldCustomer();
    const [got] = await loadCustomers();
    expect(got.searchKey).not.toContain("undefined");
  });

  it("★古い記録でも「台帳が空欄なら助っ人クラウドから補う」が効く", async () => {
    await putOldCustomer();
    const suket = customer("sk:aaa", "suketto", { postalCode: "123-4567" });
    await saveImport({
      source: "suketto",
      fileName: "suket.xlsx",
      sheetName: "住宅情報登録用シート",
      totalRows: 1,
      customers: [suket],
      skipped: [],
    } satisfies ParsedImport);
    const list = await loadCustomers();
    const dx = list.find((c) => c.source === "dx");
    expect(effectiveFields(dx!).postalCode).toBe("123-4567");
  });

  it("古い記録に手直しを足しても壊れない", async () => {
    await putOldCustomer();
    const saved = await saveCustomerEdits("dx:2101230101", { supervisor: "架空 一郎" });
    expect(effectiveFields(saved!).supervisor).toBe("架空 一郎");
    expect(effectiveFields(saved!).postalCode).toBe("");
  });
});
