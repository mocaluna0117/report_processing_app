"use client";

// 顧客データの保存 (IndexedDB の customers ストア)。
// 顧客情報はこの端末の中だけに置き、サーバーへは送らない。
// 「保存データを消去」(定期点検) では消えず、「顧客データを削除」で明示的に消す。
import { applyEdits, mergeImported } from "@/lib/after/customer";
import type { ParsedImport, SkippedGroup } from "@/lib/after/import";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";
import { STORE_CUSTOMERS, request, withStore } from "@/lib/storage";

export interface ImportReport {
  source: CustomerSource;
  fileName: string;
  sheetName: string | null;
  totalRows: number;
  /** 取り込んだ件数 (追加 + 更新) */
  imported: number;
  added: number;
  updated: number;
  /** 全置換で消えた件数 (助っ人クラウドのみ) */
  removed: number;
  /** 引き継いだ利用者の修正の件数 */
  editsPreserved: number;
  needsReview: number;
  skipped: SkippedGroup[];
}

export async function loadCustomers(): Promise<Customer[]> {
  const all = await withStore(STORE_CUSTOMERS, "readonly", (s) => request(s.getAll()));
  return (all as Customer[]).filter((c) => c && typeof c.id === "string");
}

export async function countCustomers(): Promise<{
  total: number;
  bySource: Record<CustomerSource, number>;
  lastImportedAt: number | null;
}> {
  const customers = await loadCustomers();
  const bySource: Record<CustomerSource, number> = { suketto: 0, dx: 0 };
  let lastImportedAt: number | null = null;
  for (const c of customers) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    if (lastImportedAt === null || c.importedAt > lastImportedAt) lastImportedAt = c.importedAt;
  }
  return { total: customers.length, bySource, lastImportedAt };
}

/**
 * 取り込み結果を保存する。
 * - 助っ人クラウド (旧システム): その取り込み元の分を全部入れ替える
 * - 点検保守台帳 (DX): PJ をキーに追加・更新する (今後のファイルは追加分のことがあるので消さない)
 * どちらも利用者の修正は引き継ぐ。
 */
export async function saveImport(parsed: ParsedImport): Promise<ImportReport> {
  const replaceAll = parsed.source === "suketto";
  let added = 0;
  let updated = 0;
  let removed = 0;
  let editsPreserved = 0;
  const saved: Customer[] = [];

  // 解析はトランザクションの外で終えてあるので、ここでは IndexedDB の操作だけを流す
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    const existing = (await request(store.getAll())) as Customer[];
    const previous = new Map(existing.map((c) => [c.id, c]));

    if (replaceAll) {
      for (const c of existing) {
        if (c.source !== parsed.source) continue;
        if (!parsed.customers.some((incoming) => incoming.id === c.id)) {
          store.delete(c.id);
          removed += 1;
        }
      }
    }

    for (const incoming of parsed.customers) {
      const before = previous.get(incoming.id);
      const merged = before ? mergeImported(before, incoming) : incoming;
      if (before) {
        updated += 1;
        if (Object.keys(merged.edits).length > 0) editsPreserved += 1;
      } else {
        added += 1;
      }
      store.put(merged);
      saved.push(merged);
    }
  });

  return {
    source: parsed.source,
    fileName: parsed.fileName,
    sheetName: parsed.sheetName,
    totalRows: parsed.totalRows,
    imported: parsed.customers.length,
    added,
    updated,
    removed,
    editsPreserved,
    needsReview: saved.filter((c) => c.issues.length > 0).length,
    skipped: parsed.skipped,
  };
}

/** 1件の修正を保存する (画面の顧客カードから) */
export async function saveCustomerEdits(
  id: string,
  patch: Partial<CustomerFields>,
  now: number = Date.now(),
): Promise<Customer | null> {
  let next: Customer | null = null;
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    const current = (await request(store.get(id))) as Customer | undefined;
    if (!current) return;
    next = applyEdits(current, patch, now);
    store.put(next);
  });
  return next;
}

/** 顧客データをまるごと消す (「顧客データを削除」ボタン) */
export async function clearCustomers(): Promise<void> {
  await withStore(STORE_CUSTOMERS, "readwrite", (s) => {
    s.clear();
  });
}
