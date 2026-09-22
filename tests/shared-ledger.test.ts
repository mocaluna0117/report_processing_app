import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCustomers, countCustomers, loadCustomers, saveCustomerEdits } from "@/lib/after/customer-store";
import { effectiveFields } from "@/lib/after/customer";
import { loadSeenCustomerFiles } from "@/lib/shared/store";
import { DEFAULT_SHARED_TIMING, SharedFolder } from "@/lib/shared/folder";
import { syncShared } from "@/lib/shared/sync";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { STORE_META, withStore } from "@/lib/storage";
import { FakeFs } from "./helpers/fake-fs";

// 共有フォルダーに置いた顧客データのファイルを、2人目も自動で取り込む（2026-09-23）。
// ★これまでは2人が同じ xlsx を手で取り込む前提だった。助っ人クラウドの id は行の内容の
//   ハッシュなので、別のファイルだと手直しが結び付かない。共有フォルダーから読めば必ず揃う。
// ★手で取り込む道（ドラッグ＆ドロップ）は残してある。
// データはすべて架空（架空　花子、PJ 21012301xx、電話 080-0000-xxxx）。

const QUICK = { ...DEFAULT_SHARED_TIMING, readWaitMs: 0, sleep: async () => {} };

const DX_HEADER = [
  "台帳種類", "更新区分", "物件番号", "物件名", "居住者 お客様番号", "居住者名", "居住者名カナ",
  "所在地住居表示", "所在地住居表示 - 建物名", "所在地住居表示 郵便番号",
  "居住者 連絡先1 - TEL1", "居住者 連絡先1 - email1", "居住者 連絡先1 - TEL2",
  "居住者 連絡先1 - email2", "営業担当 担当者(主)", "備考", "築年月日",
];

const dxRow = (pj: string, owner = "架空　花子") =>
  ["点検・保守台帳", "更新", pj, `(仮称)架空区北町1-2-3 ${pj} 新築工事`, "C-1", owner, "カクウ　ハナコ",
   "東京都架空区北町1-2-3", "", "123-4567", "080-0000-5678", "", "", "", "営業担当", "", ""];

// ★点検保守台帳は「物件番号の末尾が 01」の行だけを取り込む（lib/after/dx.ts）
const dxCsv = (pjs: string[]) => [DX_HEADER.join(","), ...pjs.map((pj) => dxRow(pj).join(","))].join("\n");

const setup = (files: Record<string, string> = {}) => {
  const fs = new FakeFs("Folio共有");
  for (const [name, text] of Object.entries(files)) fs.put(name, text);
  return { fs, folder: new SharedFolder(new FolderStore(fs.root), "device-A", QUICK) };
};

beforeEach(async () => {
  await clearCustomers();
  await withStore(STORE_META, "readwrite", (s) => {
    s.clear();
  });
});

describe("共有フォルダーの顧客ファイルを取り込む", () => {
  it("★2人目は手で取り込まなくても、台帳ごと揃う", async () => {
    const { folder } = setup({ "点検保守台帳.csv": dxCsv(["2101230101", "2101230201"]) });
    const report = await syncShared(folder, { now: 100, allowFirstWrite: true });

    expect((await countCustomers()).total).toBe(2);
    expect(report.ledger.imported).toHaveLength(1);
    expect(report.ledger.imported[0]).toContain("点検保守台帳.csv");
    expect(report.ledger.imported[0]).toContain("追加 2件");
  });

  it("★変わっていなければ取り込み直さない（数千件の取り込みは重い）", async () => {
    const { folder } = setup({ "台帳.csv": dxCsv(["2101230101"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    const again = await syncShared(folder, { now: 200 });
    expect(again.ledger.imported).toEqual([]);
    expect((await countCustomers()).total).toBe(1);
  });

  it("ファイルが新しくなれば取り込み直す", async () => {
    const { fs, folder } = setup({ "台帳.csv": dxCsv(["2101230101"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    fs.put("台帳.csv", dxCsv(["2101230101", "2101230201"]));
    const again = await syncShared(folder, { now: 200 });
    expect(again.ledger.imported[0]).toContain("追加 1件");
    expect((await countCustomers()).total).toBe(2);
  });

  it("★手直しは取り込み直しても残る", async () => {
    const { fs, folder } = setup({ "台帳.csv": dxCsv(["2101230101"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    await saveCustomerEdits("dx:2101230101", { memo: "この端末で直したメモ" }, 150);

    fs.put("台帳.csv", dxCsv(["2101230101", "2101230201"]));
    await syncShared(folder, { now: 200 });

    const saved = (await loadCustomers()).find((c) => c.id === "dx:2101230101")!;
    expect(effectiveFields(saved).memo).toBe("この端末で直したメモ");
  });

  it("顧客データでないファイルは飛ばして先へ進む", async () => {
    const { folder } = setup({ "打合せメモ.csv": "日付,内容\n2026/09/23,架空の打合せ" });
    const report = await syncShared(folder, { now: 100, allowFirstWrite: true });
    expect(report.ledger.imported).toEqual([]);
    expect(report.ledger.skipped.map((s) => s.file)).toEqual(["打合せメモ.csv"]);
    // ★飛ばしただけで、手直しの同期は進んでいる
    expect(report.awaitingFirstWrite).toBe(false);
  });

  it("★共有フォルダーの JSON と Excel の一時ファイルは読まない", async () => {
    const { fs, folder } = setup({ "台帳.csv": dxCsv(["2101230101"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    fs.put("~$台帳.csv", dxCsv(["2101230109"]));
    const again = await syncShared(folder, { now: 200 });
    expect(again.ledger.imported).toEqual([]);
    expect(again.ledger.skipped).toEqual([]);
  });

  it("ファイルを片付けても、顧客は消えない（印だけ落とす）", async () => {
    const { fs, folder } = setup({ "台帳.csv": dxCsv(["2101230101"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    await fs.root.removeEntry("台帳.csv");
    await syncShared(folder, { now: 200 });
    expect((await countCustomers()).total).toBe(1);
    expect(await loadSeenCustomerFiles()).toEqual({});
  });
});

describe("助っ人クラウドは丸ごと入れ替わるので、減るときは確かめる", () => {
  // 助っ人クラウドの列（このテストでは件数だけを見る）
  const SUKET_HEADER = [
    "管理ID", "施主名(姓)", "施主名(名)", "施主名かな(姓)", "施主名かな(名)",
    "住宅名(物件名)(区画番号)など", "建築地都道府県", "建築地市区町村番地", "建築地郵便番号",
    "現住所郵便番号", "建築地電話番号", "建築地携帯電話番号", "引渡日", "担当支店",
  ];
  const suketRow = (id: string) =>
    [id, "架空", "花子", "カクウ", "ハナコ", `架空台1丁目 ${id}号棟`, "東京都", "架空区北町1-2-3",
     "123-4567", "", "03-0000-1234", "090-0000-1234", "2025/09/26", "架空支店"];
  const suketCsv = (ids: string[]) =>
    [SUKET_HEADER.join(","), ...ids.map((id) => suketRow(id).join(","))].join("\n");

  it("初めてなら、失うものが無いのでそのまま取り込む", async () => {
    const { folder } = setup({ "助っ人.csv": suketCsv(["A1", "A2", "A3"]) });
    const report = await syncShared(folder, { now: 100, allowFirstWrite: true });
    expect(report.ledger.imported).toHaveLength(1);
    expect((await countCustomers()).bySource.suketto).toBe(3);
  });

  it("★減るときは黙って入れ替えず、件数を出して確かめる", async () => {
    const { fs, folder } = setup({ "助っ人.csv": suketCsv(["A1", "A2", "A3"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });

    fs.put("助っ人.csv", suketCsv(["A1"]));
    const again = await syncShared(folder, { now: 200 });
    expect(again.ledger.imported).toEqual([]);
    expect(again.ledger.pending).toHaveLength(1);
    expect(again.ledger.pending[0].text).toContain("3件");
    expect(again.ledger.pending[0].text).toContain("1件");
    // ★確かめるまでは入れ替えない
    expect((await countCustomers()).bySource.suketto).toBe(3);
  });

  it("確かめてもらえたら入れ替える", async () => {
    const { fs, folder } = setup({ "助っ人.csv": suketCsv(["A1", "A2", "A3"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    fs.put("助っ人.csv", suketCsv(["A1"]));

    const done = await syncShared(folder, { now: 200, allowLedgerReplace: true });
    expect(done.ledger.pending).toEqual([]);
    expect(done.ledger.imported).toHaveLength(1);
    expect((await countCustomers()).bySource.suketto).toBe(1);
  });

  it("増えるときは確かめずに取り込む", async () => {
    const { fs, folder } = setup({ "助っ人.csv": suketCsv(["A1"]) });
    await syncShared(folder, { now: 100, allowFirstWrite: true });
    fs.put("助っ人.csv", suketCsv(["A1", "A2"]));
    const again = await syncShared(folder, { now: 200 });
    expect(again.ledger.pending).toEqual([]);
    expect((await countCustomers()).bySource.suketto).toBe(2);
  });
});
