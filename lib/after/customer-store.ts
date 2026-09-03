"use client";

// 顧客データの保存 (IndexedDB の customers ストア)。
// 顧客情報はこの端末の中だけに置き、サーバーへは送らない。
// 「保存データを消去」(定期点検) では消えず、「顧客データを削除」で明示的に消す。
import {
  applyEdits,
  applyReportHandoverDate,
  mergeImported,
  needsReview,
  withSupplements,
} from "@/lib/after/customer";
import { resolveDuplicates, withDuplicateIssue } from "@/lib/after/dedup";
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
  /** 点検保守台帳と同じ物件だったので消した (取り込まなかった) 助っ人クラウドの件数 */
  dedupRemoved: number;
  /** 点検保守台帳の空欄を助っ人クラウドから補った顧客の件数 */
  supplemented: number;
  /** 重複かもしれないので消さずに残した助っ人クラウドの件数 */
  dedupUncertain: number;
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
 *
 * 保存の前に、両方の全件を突き合わせて重複を解消する (lib/after/dedup.ts)。
 * 点検保守台帳が正なので、同じ物件が両方にあれば助っ人クラウド側を消し、
 * 台帳が空欄の項目だけを助っ人クラウドから補う。
 * どちらを先に取り込んでも、また何度取り込み直しても同じ結果になるよう、毎回まとめて判定する。
 */
export async function saveImport(parsed: ParsedImport): Promise<ImportReport> {
  const replaceAll = parsed.source === "suketto";
  let added = 0;
  let updated = 0;
  let removed = 0;
  let dedupRemoved = 0;
  let supplemented = 0;
  let dedupUncertain = 0;
  let editsPreserved = 0;
  const saved: Customer[] = [];

  // 解析はトランザクションの外で終えてあるので、ここでは IndexedDB の操作だけを流す
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    const existing = (await request(store.getAll())) as Customer[];
    const previous = new Map(existing.map((c) => [c.id, c]));

    // 取り込んだ分に、前回の修正・補完を引き継ぐ
    const incoming = parsed.customers.map((c) => {
      const before = previous.get(c.id);
      return before ? mergeImported(before, c) : c;
    });
    const incomingIds = new Set(incoming.map((c) => c.id));
    // 反対側の取り込み元 (助っ人クラウドを取り込むなら点検保守台帳、その逆も)
    const others = existing.filter((c) => c.source !== parsed.source);
    // 取り込み後にあるべき全件
    const keptSameSource = existing.filter(
      (c) => c.source === parsed.source && !incomingIds.has(c.id) && !replaceAll,
    );

    const suketto = replaceAll ? incoming : others;
    const dx = replaceAll ? others : [...incoming, ...keptSameSource];
    const { removeIds, supplements, uncertainIds } = resolveDuplicates(suketto, dx);
    dedupRemoved = removeIds.size;
    dedupUncertain = uncertainIds.size;
    supplemented = supplements.size;

    // 台帳の空欄を補い、助っ人クラウド側には重複の疑いを知らせる
    const resolved = [
      ...suketto
        .filter((c) => !removeIds.has(c.id))
        .map((c) => withDuplicateIssue(c, uncertainIds.has(c.id))),
      // 前回の補完も渡す: 元になった助っ人クラウドの行はもう消えているので、
      // ここで引き継がないと台帳の空欄 (引渡日など) が戻ってしまう
      ...dx.map((c) => withSupplements(c, { ...c.supplements, ...supplements.get(c.id) })),
    ];
    const keptIds = new Set(resolved.map((c) => c.id));

    // 消すもの: 全置換で無くなった行と、点検保守台帳と重複していた助っ人クラウドの行
    for (const c of existing) {
      if (keptIds.has(c.id)) continue;
      store.delete(c.id);
      if (!removeIds.has(c.id)) removed += 1;
    }

    for (const customer of resolved) {
      const before = previous.get(customer.id);
      if (incomingIds.has(customer.id)) {
        if (before) {
          updated += 1;
          if (Object.keys(customer.edits).length > 0) editsPreserved += 1;
        } else {
          added += 1;
        }
        store.put(customer);
        saved.push(customer);
      } else if (before && before !== customer) {
        // 反対側の取り込みで補完や知らせが変わった分だけ書き戻す
        store.put(customer);
      }
    }
  });

  return {
    source: parsed.source,
    fileName: parsed.fileName,
    sheetName: parsed.sheetName,
    totalRows: parsed.totalRows,
    imported: added + updated,
    added,
    updated,
    removed,
    dedupRemoved,
    supplemented,
    dedupUncertain,
    editsPreserved,
    needsReview: saved.filter(needsReview).length,
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

/** 写真報告書から反映する引渡日1件分 */
export interface ReportHandoverUpdate {
  id: string;
  /** yyyy/mm/dd (ゼロ埋め) */
  date: string;
  /** 元になった報告書のPJ (表示用) */
  pj: string | null;
}

/**
 * 定期点検の報告書の引渡日を顧客データへ反映する (まとめて1トランザクションで書く)。
 * 見つからないIDは飛ばし、実際に書いた顧客を返す。
 */
export async function saveReportHandoverDates(
  updates: readonly ReportHandoverUpdate[],
  now: number = Date.now(),
): Promise<Customer[]> {
  const saved: Customer[] = [];
  if (updates.length === 0) return saved;
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    for (const update of updates) {
      const current = (await request(store.get(update.id))) as Customer | undefined;
      if (!current) continue;
      const next = applyReportHandoverDate(current, update.date, update.pj, now);
      store.put(next);
      saved.push(next);
    }
  });
  return saved;
}

/** 顧客データをまるごと消す (「顧客データを削除」ボタン) */
export async function clearCustomers(): Promise<void> {
  await withStore(STORE_CUSTOMERS, "readwrite", (s) => {
    s.clear();
  });
}
