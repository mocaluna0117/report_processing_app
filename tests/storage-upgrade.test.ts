import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { saveImport } from "@/lib/after/customer-store";
import { STORE_CUSTOMERS, request, withStore } from "@/lib/storage";
import type { Customer } from "@/lib/after/types";

// 保存済みの端末を v2 から開き直す経路を確かめる。
// lib/storage.ts は開いた接続をモジュール内に持つので、このファイルだけで完結させる
// (vitest はテストファイルごとにモジュールを読み直す)。

const customer = (id: string): Customer => ({
  id,
  source: "dx",
  sourceKey: id,
  sourceRow: 2,
  imported: {
    pj: "2101230101",
    developer: "タカマツハウス",
    propertyName: "架空台1丁目 A号棟",
    ownerName: "架空　太郎",
    ownerKana: "カクウ　タロウ",
    postalCode: "",
    address: "東京都架空区北町1-2-3",
    contacts: [],
    emails: [],
    handoverDate: "2025/09/26",
    supervisor: "",
    salesRep: "",
    memo: "",
  },
  edits: {},
  issues: [],
  corporate: false,
  searchKey: id,
  importedAt: 1,
  editedAt: null,
});

/** v2 のときの形 (customers に source 索引が張ってある) を作る */
function createV2Database(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("folio", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("files", { keyPath: "id" });
      db.createObjectStore("merged");
      db.createObjectStore("meta");
      const store = db.createObjectStore(STORE_CUSTOMERS, { keyPath: "id" });
      store.createIndex("source", "source");
      store.put(customer("dx:古い"));
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

describe("保存データの作り直し (v2 → v3)", () => {
  it("v2 で作った source 索引を外し、保存済みの顧客はそのまま残す", async () => {
    await createV2Database();

    // アプリ側から開くと v3 へ上がる
    const names = await withStore(STORE_CUSTOMERS, "readonly", (s) => [...s.indexNames]);
    expect(names).toEqual([]);

    const kept = (await withStore(STORE_CUSTOMERS, "readonly", (s) => request(s.getAll()))) as Customer[];
    expect(kept.map((c) => c.id)).toEqual(["dx:古い"]);

    // 上げた後も読み書きできる
    await saveImport({
      source: "dx",
      fileName: "f.xlsx",
      sheetName: "Sheet1",
      customers: [customer("dx:新しい")],
      skipped: [],
      totalRows: 1,
    });
    const all = (await withStore(STORE_CUSTOMERS, "readonly", (s) => request(s.getAll()))) as Customer[];
    expect(all.map((c) => c.id).sort()).toEqual(["dx:古い", "dx:新しい"]);
  });
});
