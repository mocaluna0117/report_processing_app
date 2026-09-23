import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { effectiveFields } from "@/lib/after/customer";
import { clearCustomers, loadCustomers } from "@/lib/after/customer-store";
import type { Customer, CustomerFields } from "@/lib/after/types";
import {
  clearStoredExamples,
  deleteStoredExample,
  loadDeletedExampleMarks,
  loadExamples,
  upsertStoredExample,
} from "@/lib/examples-store";
import {
  type SharedCustomerEdits,
  mergeCustomerEdits,
  pickSharedCustomerEdits,
} from "@/lib/shared/customer-edits";
import { SHARED_DATASETS } from "@/lib/shared/datasets";
import {
  type SharedExamples,
  mergeSharedExamples,
  pickSharedExamples,
} from "@/lib/shared/examples";
import { DEFAULT_SHARED_TIMING, SharedFolder } from "@/lib/shared/folder";
import { loadDeviceId, loadLastSync, newDeviceId } from "@/lib/shared/store";
import { hasAnySharedData, syncShared } from "@/lib/shared/sync";
import type { InquiryExample } from "@/lib/summarize/examples";
import { STORE_CUSTOMERS, withStore } from "@/lib/storage";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { FakeFs } from "./helpers/fake-fs";

// 共有フォルダー ↔ ブラウザの保存の橋渡し（2026-09-22）。
// ★この端末は本物の保存（fake-indexeddb）、**相手のPC**は同じフォルダーを開いた別の
//   SharedFolder で再現する（tests/shared-folder.test.ts と同じ手口）。
// データはすべて架空（山田　太郎／架空　花子、PJ 21012301xx、電話 090-0000-xxxx）。

const EDITS = SHARED_DATASETS["customer-edits"];
const LEARN = SHARED_DATASETS["examples-inquiry"];
const LEARN2 = SHARED_DATASETS["examples-inspection"];
const LEDGER = SHARED_DATASETS["customer-ledger"];

const QUICK = { ...DEFAULT_SHARED_TIMING, readWaitMs: 0, sleep: async () => {} };
/** ★共有データは直下ではなく、この中に入る（業務のフォルダーと混ぜないため） */
const DATA = "_data";
const at = (file: string) => `${DATA}/${file}`;

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

const putCustomers = (list: Customer[]) =>
  withStore(STORE_CUSTOMERS, "readwrite", (s) => {
    for (const c of list) s.put(c);
  });

const example = (over: Partial<InquiryExample> = {}): InquiryExample => ({
  id: "c-1",
  input: "浴室の換気扇から異音がするとのこと",
  output: "浴室の換気扇から異音",
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

/** 相手のPC（同じフォルダーを開いた別の端末） */
const other = (fs: FakeFs) => new SharedFolder(new FolderStore(fs.root), "device-B", QUICK);

// ★相手のPCも、書く前に共有データのフォルダーを決める（本番と同じ順番）
const pushEdits = async (folder: SharedFolder, mine: SharedCustomerEdits, now: number) => {
  await folder.ensureDataDir();
  return folder.update(EDITS, pickSharedCustomerEdits, (c) => (c ? mergeCustomerEdits(c, mine) : mine), now);
};

const pushExamples = async (folder: SharedFolder, mine: SharedExamples, now: number) => {
  await folder.ensureDataDir();
  return folder.update(LEARN, pickSharedExamples, (c) => (c ? mergeSharedExamples(c, mine) : mine), now);
};

const setup = () => {
  const fs = new FakeFs("Folio共有");
  return { fs, mine: new SharedFolder(new FolderStore(fs.root), "device-A", QUICK) };
};

beforeEach(async () => {
  await clearCustomers();
  await clearStoredExamples("inquiry");
  await clearStoredExamples("inspection");
  // ★「消した印」もテストごとに戻す（clearStoredExamples は印を押すので残る）
  await withStore("meta", "readwrite", (s) => {
    s.clear();
  });
});

describe("この端末の目印と最後の同期", () => {
  it("目印は乱数で、氏名やPC名を含まない。一度作れば変わらない", async () => {
    const id = await loadDeviceId();
    expect(id).not.toBe("");
    expect(await loadDeviceId()).toBe(id);
    expect(newDeviceId()).not.toBe(newDeviceId());
  });

  it("まだ同期していなければ日時は無い", async () => {
    expect(await loadLastSync()).toBeNull();
  });
});

describe("まだ空のフォルダー", () => {
  it("★尋ねずには書き出さない（選び間違えたフォルダーに中身を作らない）", async () => {
    const { fs, mine } = setup();
    await putCustomers([{ ...customer(), edits: { memo: "架空のメモ" }, editStamps: { memo: 5 }, editedAt: 5 }]);
    await upsertStoredExample("inquiry", example());

    const report = await syncShared(mine, { now: 100 });
    expect(report.awaitingFirstWrite).toBe(true);
    expect(fs.files()).toEqual([]);
    // 画面に出す件数（「手直し1件・学習1件を書き出します」）
    expect(report.pending.customers).toBe(1);
    expect(report.pending.examples.inquiry).toBe(1);
    expect(await loadLastSync()).toBeNull();
  });

  it("許してもらえたら4つのファイルを作る", async () => {
    const { fs, mine } = setup();
    await putCustomers([{ ...customer(), edits: { memo: "架空のメモ" }, editStamps: { memo: 5 }, editedAt: 5 }]);
    await upsertStoredExample("inquiry", example());

    const report = await syncShared(mine, { now: 100, allowFirstWrite: true });
    expect(report.awaitingFirstWrite).toBe(false);
    expect(fs.files()).toEqual([EDITS.file, LEARN.file, LEARN2.file, LEDGER.file].map(at).sort());
    expect(report.customers.written).toBe(true);
    expect(await loadLastSync()).toBe(100);

    const written = JSON.parse(fs.text(at(EDITS.file)) ?? "");
    expect(written.kind).toBe(EDITS.kind);
    expect(written.schemaVersion).toBe(EDITS.schemaVersion);
    expect(written.writer).toBe("device-A");
    expect(written.items["dx:2101230101"].edits.memo).toBe("架空のメモ");
    // ★台帳の取り込み値そのものは置かない（手直しだけ）
    expect(JSON.stringify(written.items)).not.toContain("山田");
  });

  it("フォルダーに1つでもあれば、もう尋ねない", async () => {
    const { fs, mine } = setup();
    await pushEdits(other(fs), {}, 50);
    expect(await hasAnySharedData(mine)).toBe(true);
    expect((await syncShared(mine, { now: 100 })).awaitingFirstWrite).toBe(false);
  });
});

describe("相手の手直しを受け取る", () => {
  it("同じ顧客がいれば手直しが付き、いない分は数えるだけで捨てない", async () => {
    const { fs, mine } = setup();
    await putCustomers([customer()]);
    await pushEdits(
      other(fs),
      {
        "dx:2101230101": {
          source: "dx", sourceKey: "2101230101",
          edits: { supervisor: "架空　花子" }, editStamps: { supervisor: 20 }, editedAt: 20,
        },
        "sk:ffffffff": {
          source: "suketto", sourceKey: "9999",
          edits: { memo: "相手にしか無い顧客" }, editStamps: { memo: 20 }, editedAt: 20,
        },
      },
      50,
    );

    const report = await syncShared(mine, { now: 100 });
    expect(report.customers.applied).toBe(1);
    expect(report.customers.unmatched).toBe(1);
    const saved = await loadCustomers();
    expect(effectiveFields(saved[0]).supervisor).toBe("架空　花子");
    // ★見つからない手直しはファイルに残す（同じ xlsx を取り込めば結び付く）
    const file = JSON.parse(fs.text(at(EDITS.file)) ?? "");
    expect(Object.keys(file.items)).toContain("sk:ffffffff");
  });

  it("★別々の項目を直していれば、両方残る", async () => {
    const { fs, mine } = setup();
    await putCustomers([
      { ...customer(), edits: { memo: "こちらのメモ" }, editStamps: { memo: 30 }, editedAt: 30 },
    ]);
    await pushEdits(
      other(fs),
      {
        "dx:2101230101": {
          source: "dx", sourceKey: "2101230101",
          edits: { salesRep: "架空　花子" }, editStamps: { salesRep: 20 }, editedAt: 20,
        },
      },
      50,
    );

    await syncShared(mine, { now: 100 });
    const saved = effectiveFields((await loadCustomers())[0]);
    expect(saved.memo).toBe("こちらのメモ");
    expect(saved.salesRep).toBe("架空　花子");
  });

  it("★同じ項目なら、あとから直した方が残る（相手が古ければ上書きされない）", async () => {
    const { fs, mine } = setup();
    await putCustomers([
      { ...customer(), edits: { memo: "新しい" }, editStamps: { memo: 30 }, editedAt: 30 },
    ]);
    await pushEdits(
      other(fs),
      {
        "dx:2101230101": {
          source: "dx", sourceKey: "2101230101",
          edits: { memo: "古い" }, editStamps: { memo: 10 }, editedAt: 10,
        },
      },
      50,
    );

    await syncShared(mine, { now: 100 });
    expect(effectiveFields((await loadCustomers())[0]).memo).toBe("新しい");
    // ファイル側も新しい方に揃う
    const file = JSON.parse(fs.text(at(EDITS.file)) ?? "");
    expect(file.items["dx:2101230101"].edits.memo).toBe("新しい");
  });

  it("手直しの無い顧客は書き戻さない（数千件の空書きを避ける）", async () => {
    const { fs, mine } = setup();
    await putCustomers([customer(), customer("dx:2101230102")]);
    await pushEdits(other(fs), {}, 50);
    const report = await syncShared(mine, { now: 100 });
    expect(report.customers.applied).toBe(0);
  });
});

describe("学習した書き方", () => {
  it("相手が学習した分がこの端末にも入る", async () => {
    const { fs, mine } = setup();
    await pushExamples(other(fs), { items: [example({ id: "b-1", output: "相手が学習" })], deleted: {} }, 50);

    const report = await syncShared(mine, { now: 100 });
    expect(report.examples.inquiry.count).toBe(1);
    expect((await loadExamples("inquiry")).map((e) => e.id)).toEqual(["b-1"]);
  });

  it("★この端末で消した手本は、印が伝わって相手のファイルからも落ちる", async () => {
    const { fs, mine } = setup();
    await upsertStoredExample("inquiry", example({ id: "c-1" }));
    await syncShared(mine, { now: 100, allowFirstWrite: true });

    await deleteStoredExample("inquiry", "c-1", 2_000);
    expect(await loadDeletedExampleMarks("inquiry")).toEqual({ "c-1": 2_000 });

    await syncShared(mine, { now: 3_000 });
    const file = JSON.parse(fs.text(at(LEARN.file)) ?? "");
    expect(file.items.items).toEqual([]);
    expect(file.items.deleted).toEqual({ "c-1": 2_000 });
  });

  it("★相手が消した手本は、この端末からも消える（印が無いと戻ってきてしまう）", async () => {
    const { fs, mine } = setup();
    await upsertStoredExample("inquiry", example({ id: "c-1" }));
    await syncShared(mine, { now: 100, allowFirstWrite: true });

    // 相手のPCで消した（手本を覚えた 1000 より後）
    await pushExamples(other(fs), { items: [], deleted: { "c-1": 2_000 } }, 2_100);

    await syncShared(mine, { now: 3_000 });
    expect(await loadExamples("inquiry")).toEqual([]);
  });

  it("消したあとに学習し直せば復活する", async () => {
    const { fs, mine } = setup();
    await pushExamples(other(fs), { items: [], deleted: { "c-1": 2_000 } }, 2_100);
    await upsertStoredExample("inquiry", example({ id: "c-1", updatedAt: 3_000, output: "覚え直した" }));

    await syncShared(mine, { now: 4_000 });
    expect((await loadExamples("inquiry")).map((e) => e.output)).toEqual(["覚え直した"]);
    expect(fs.text(at(LEARN.file))).toContain("覚え直した");
  });

  it("アフターと定期点検の手本は混ざらない", async () => {
    const { fs, mine } = setup();
    await upsertStoredExample("inquiry", example({ id: "a-1", output: "アフター" }));
    await upsertStoredExample("inspection", example({ id: "i-1", output: "定期点検" }));

    await syncShared(mine, { now: 100, allowFirstWrite: true });
    expect(fs.text(at(LEARN.file))).toContain("アフター");
    expect(fs.text(at(LEARN.file))).not.toContain("定期点検");
    expect(fs.text(at(LEARN2.file))).toContain("定期点検");
  });
});

describe("何度同期しても壊れない", () => {
  it("★変わっていなければ2回目は書かない（控えを無駄に潰さない）", async () => {
    const { fs, mine } = setup();
    await putCustomers([{ ...customer(), edits: { memo: "架空のメモ" }, editStamps: { memo: 5 }, editedAt: 5 }]);
    await upsertStoredExample("inquiry", example());
    await syncShared(mine, { now: 100, allowFirstWrite: true });

    const before = fs.writes.length;
    const again = await syncShared(mine, { now: 200 });
    expect(again.customers.written).toBe(false);
    expect(again.examples.inquiry.written).toBe(false);
    expect(fs.writes.length).toBe(before);
    expect(fs.files()).not.toContain(at(`${EDITS.file}.bak`));
  });

  it("同期を重ねても中身は変わらない（冪等）", async () => {
    const { fs, mine } = setup();
    await putCustomers([{ ...customer(), edits: { memo: "架空のメモ" }, editStamps: { memo: 5 }, editedAt: 5 }]);
    await syncShared(mine, { now: 100, allowFirstWrite: true });
    const first = fs.text(at(EDITS.file));
    await syncShared(mine, { now: 200 });
    await syncShared(mine, { now: 300 });
    expect(fs.text(at(EDITS.file))).toBe(first);
    expect((await loadCustomers()).length).toBe(1);
  });
});

describe("つまずいたとき", () => {
  it("★学習のファイルが壊れていても、顧客の手直しは同期する", async () => {
    const { fs, mine } = setup();
    await putCustomers([customer()]);
    await pushEdits(
      other(fs),
      {
        "dx:2101230101": {
          source: "dx", sourceKey: "2101230101",
          edits: { memo: "生きている" }, editStamps: { memo: 20 }, editedAt: 20,
        },
      },
      50,
    );
    fs.put(at(LEARN.file), "{ 壊れた");

    const report = await syncShared(mine, { now: 100 });
    expect(report.customers.applied).toBe(1);
    expect(report.failures.map((f) => f.dataset)).toEqual(["examples-inquiry"]);
    expect(report.failures[0].label).toBe(LEARN.label);
    // ★壊れたファイルは自分で直さない（書き換えずに残す）
    expect(fs.text(at(LEARN.file))).toBe("{ 壊れた");
    expect(await loadLastSync()).toBe(100);
  });

  it("★新しい Folio が書いた形は読まず・書かない", async () => {
    const { fs, mine } = setup();
    fs.put(
      LEARN.file,
      JSON.stringify({ schemaVersion: 99, kind: LEARN.kind, updatedAt: "", writer: "x", items: { items: [], deleted: {} } }),
    );
    await upsertStoredExample("inquiry", example());

    const report = await syncShared(mine, { now: 100 });
    expect(report.failures[0].message).toContain("新しくしてください");
    expect(JSON.parse(fs.text(at(LEARN.file)) ?? "").schemaVersion).toBe(99);
  });

  it("フォルダーが無くなったら投げる（ローカルは触らない）", async () => {
    const { fs, mine } = setup();
    await putCustomers([customer()]);
    fs.vanish();
    await expect(syncShared(mine, { now: 100 })).rejects.toThrow();
    expect(await loadLastSync()).toBeNull();
  });
});

describe("前の形（直下に置いていた分）からの移し替え", () => {
  it("★つないだときに、直下のファイルをデータのフォルダーへ移す", async () => {
    const { fs, mine } = setup();
    // 前の形: 共有データが共有フォルダーの直下にあった
    await pushEdits(new SharedFolder(new FolderStore(fs.root), "device-old", QUICK), {}, 50);
    const before = fs.files();
    expect(before).toContain(at(EDITS.file));

    // いまの形に作り直す（直下へ置き直して、移し替えが起きることを見る）
    fs.put(EDITS.file, fs.text(at(EDITS.file)) ?? "");
    await (await fs.root.getDirectoryHandle("_data")).removeEntry(EDITS.file);
    expect(fs.files()).toContain(EDITS.file);

    await syncShared(mine, { now: 100 });
    expect(fs.files()).toContain(at(EDITS.file));
    // ★直下からは消える（同じものが2つ並ばない）
    expect(fs.files()).not.toContain(EDITS.file);
  });

  it("★移し先に同じ名前があれば、直下のものは消さない（取り違えたら戻せない）", async () => {
    const { fs, mine } = setup();
    await pushEdits(new SharedFolder(new FolderStore(fs.root), "device-old", QUICK), {}, 50);
    fs.put(EDITS.file, "直下に残っていた別の中身");

    await syncShared(mine, { now: 100 });
    expect(fs.text(EDITS.file)).toBe("直下に残っていた別の中身");
  });
});
