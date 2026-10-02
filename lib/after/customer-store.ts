"use client";

// 顧客データの保存 (IndexedDB の customers ストア)。
// 顧客情報はこの端末の中だけに置き、サーバーへは送らない。
// 「保存データを消去」(定期点検) では消えず、「顧客データを削除」で明示的に消す。
import {
  applyEdits,
  applyReportHandoverDate,
  applyTenmatsuStaff,
  mergeImported,
  needsReview,
  normalizeStoredCustomer,
  revertTenmatsuStaff,
  withSupplements,
} from "@/lib/after/customer";
import { resolveDuplicates, withDuplicateIssue } from "@/lib/after/dedup";
import type { ParsedImport, SkippedGroup } from "@/lib/after/import";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";
import {
  type SharedCustomerEdits,
  applySharedCustomerEdits,
  extractCustomerEdits,
} from "@/lib/shared/customer-edits";
import {
  type LedgerSource,
  type SharedLedger,
  extractLedger,
  mergeDeletedMarks,
  sameLedgerSource,
  toCustomers,
} from "@/lib/shared/ledger";
import {
  SETTING_KEY_SHARED_MANUAL_DELETED,
  STORE_CUSTOMERS,
  loadMeta,
  request,
  saveMeta,
  withStore,
} from "@/lib/storage";

export interface ImportReport {
  source: CustomerSource;
  fileName: string;
  sheetName: string | null;
  totalRows: number;
  /** 取り込んだ件数 (追加 + 更新) */
  imported: number;
  added: number;
  updated: number;
  /** 全置換で消えた件数 (助っ人クラウドのみ。手入力は共有フォルダーで消された件数) */
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
  return (all as Customer[])
    .filter((c) => c && typeof c.id === "string")
    .map(normalizeStoredCustomer);
}

export async function countCustomers(): Promise<{
  total: number;
  bySource: Record<CustomerSource, number>;
  lastImportedAt: number | null;
}> {
  const customers = await loadCustomers();
  const bySource: Record<CustomerSource, number> = { suketto: 0, dx: 0, manual: 0 };
  let lastImportedAt: number | null = null;
  for (const c of customers) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    // 手入力の登録は「取り込み」ではないので数えない
    if (c.source === "manual") continue;
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
 *
 * ★手入力で登録したお客様には触らない (消さない・重複の判定にも入れない)。
 *   取り込み元のファイルに無いお客様なので、ファイルを取り込み直しても無くなってはいけない。
 */
export async function saveImport(parsed: ParsedImport): Promise<ImportReport> {
  if (parsed.source === "manual") throw new Error("手入力のお客様はファイルから取り込めません");
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
    const existing = ((await request(store.getAll())) as Customer[])
      .map(normalizeStoredCustomer)
      .filter((c) => c.source !== "manual");
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

/** 手入力で登録したお客様を保存する */
export async function saveManualCustomer(customer: Customer): Promise<void> {
  if (customer.source !== "manual") throw new Error("手入力のお客様ではありません");
  await withStore(STORE_CUSTOMERS, "readwrite", (store) => {
    store.put(customer);
  });
}

/** この端末で消した手入力のお客様の印 (id → 消した時刻) */
export async function loadManualDeleted(): Promise<Record<string, number>> {
  const raw = await loadMeta<unknown>(SETTING_KEY_SHARED_MANUAL_DELETED);
  return mergeDeletedMarks(
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter(([, at]) => typeof at === "number" && Number.isFinite(at)),
        )
      : {},
  );
}

/**
 * 手入力で登録したお客様を1件消す。
 * ★先に消した印を残してから消す。印が無いと、共有フォルダーの台帳から次の同期で戻ってくる
 *   (印を残したあとで消すのに失敗しても、次の同期で印のとおりに消える)。
 * ★取り込んだお客様は消さない (ファイルを取り込み直すと戻るので、消しても意味が無い)。
 */
export async function deleteManualCustomer(id: string, now: number = Date.now()): Promise<void> {
  const current = (await withStore(STORE_CUSTOMERS, "readonly", (s) => request(s.get(id)))) as
    | Customer
    | undefined;
  if (current && current.source !== "manual") throw new Error("手入力のお客様ではありません");
  await saveMeta(
    SETTING_KEY_SHARED_MANUAL_DELETED,
    mergeDeletedMarks(await loadManualDeleted(), { [id]: now }),
  );
  await withStore(STORE_CUSTOMERS, "readwrite", (store) => {
    store.delete(id);
  });
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
    next = applyEdits(normalizeStoredCustomer(current), patch, now);
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
      const next = applyReportHandoverDate(
        normalizeStoredCustomer(current), update.date, update.pj, now);
      store.put(next);
      saved.push(next);
    }
  });
  return saved;
}

/** 顛末書から反映する監督・営業1件分 */
export interface TenmatsuStaffUpdate {
  id: string;
  supervisor?: string;
  salesRep?: string;
  /** 元になった顛末書のPJ (表示用) */
  pj: string | null;
}

/**
 * 顛末書の監督・営業を顧客データへ反映する (まとめて1トランザクションで書く)。
 * 見つからないIDは飛ばし、実際に書いた顧客を返す。
 */
export async function saveTenmatsuStaff(
  updates: readonly TenmatsuStaffUpdate[],
  now: number = Date.now(),
): Promise<Customer[]> {
  const saved: Customer[] = [];
  if (updates.length === 0) return saved;
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    for (const update of updates) {
      const current = (await request(store.get(update.id))) as Customer | undefined;
      if (!current) continue;
      const patch: { supervisor?: string; salesRep?: string } = {};
      if (update.supervisor !== undefined) patch.supervisor = update.supervisor;
      if (update.salesRep !== undefined) patch.salesRep = update.salesRep;
      const next = applyTenmatsuStaff(
        normalizeStoredCustomer(current), patch, update.pj, now);
      store.put(next);
      saved.push(next);
    }
  });
  return saved;
}

/** 顛末書から入れた監督・営業を元に戻す */
export async function clearTenmatsuStaff(
  id: string,
  fields: readonly ("supervisor" | "salesRep")[],
  now: number = Date.now(),
): Promise<Customer | null> {
  let next: Customer | null = null;
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    const current = (await request(store.get(id))) as Customer | undefined;
    if (!current) return;
    next = revertTenmatsuStaff(normalizeStoredCustomer(current), fields, now);
    store.put(next);
  });
  return next;
}

/** 共有フォルダーに載せる形で、この端末の台帳を取り出す (手入力のお客様の消した印も載せる) */
export async function loadSharedLedger(): Promise<SharedLedger> {
  return extractLedger(await loadCustomers(), await loadManualDeleted());
}

/**
 * 共有フォルダーから読んだ台帳を、この端末へ当てる。
 *
 * ★取り込みと同じ道を通す（saveImport）。手直しの引き継ぎ・重複の解消・空欄の補完が
 *   そのまま効くので、規則が二重にならない。
 * ★中身が同じ取り込み元は書き戻さない（数千件の書き戻しは重い）。
 * ★手入力のお客様は取り込みの道を通さない（重複の判定・全置換の対象ではないため）。
 */
export async function applySharedLedger(ledger: SharedLedger): Promise<ImportReport[]> {
  const mine = extractLedger(await loadCustomers());
  const reports: ImportReport[] = [];
  if (ledger.manual) reports.push(await applyManualLedger(ledger.manual));
  for (const source of ["dx", "suketto"] as const) {
    const incoming = ledger[source];
    if (!incoming || incoming.customers.length === 0) continue;
    if (sameLedgerSource(mine[source], incoming)) continue;
    reports.push(
      await saveImport({
        source,
        fileName: "共有フォルダー",
        sheetName: null,
        totalRows: incoming.customers.length,
        customers: toCustomers(incoming),
        skipped: [],
      }),
    );
  }
  return reports;
}

/**
 * 共有フォルダーの台帳の「手入力」の分をこの端末へ当てる。
 * - 消した印は、この端末の印に重ねて残す (次にこの端末から書き出すときも印を運ぶため)
 * - 印のあるお客様はこの端末からも消す
 * - この端末に無いお客様は足す。あるお客様は手直しを残したまま、新しい方の登録内容に揃える
 */
async function applyManualLedger(incoming: LedgerSource): Promise<ImportReport> {
  const before = await loadManualDeleted();
  const deleted = mergeDeletedMarks(before, incoming.deleted);
  if (JSON.stringify(deleted) !== JSON.stringify(before)) {
    await saveMeta(SETTING_KEY_SHARED_MANUAL_DELETED, deleted);
  }
  let added = 0;
  let updated = 0;
  let removed = 0;
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    const existing = ((await request(store.getAll())) as Customer[])
      .filter((c) => c && typeof c.id === "string")
      .map(normalizeStoredCustomer);
    const byId = new Map(existing.map((c) => [c.id, c]));
    for (const c of existing) {
      if (c.source !== "manual" || !(c.id in deleted)) continue;
      store.delete(c.id);
      removed += 1;
    }
    for (const c of toCustomers(incoming)) {
      if (c.source !== "manual" || c.id in deleted) continue;
      const mine = byId.get(c.id);
      if (!mine) {
        store.put(c);
        added += 1;
      } else if (mine.source === "manual" && c.importedAt > mine.importedAt) {
        store.put(mergeImported(mine, c));
        updated += 1;
      }
    }
  });
  return {
    source: "manual",
    fileName: "共有フォルダー",
    sheetName: null,
    totalRows: incoming.customers.length,
    imported: added + updated,
    added,
    updated,
    removed,
    dedupRemoved: 0,
    supplemented: 0,
    dedupUncertain: 0,
    editsPreserved: 0,
    needsReview: 0,
    skipped: [],
  };
}

/** 共有フォルダーに載せる形で、この端末の手直しを取り出す */
export async function loadSharedCustomerEdits(): Promise<SharedCustomerEdits> {
  return extractCustomerEdits(await loadCustomers());
}

export interface SharedMergeReport {
  /** 手直しが変わった顧客の件数 */
  applied: number;
  /** この端末の顧客データに見つからなかった手直しの id（同じ xlsx を取り込むと結び付く） */
  unmatched: string[];
}

/**
 * 共有フォルダーから読んだ手直しを、この端末の顧客データへ重ねる（同期の「ファイル → 写し」側）。
 *
 * ★1トランザクションの中で読み直して重ねる。ファイルを読んでからここへ来るまでの間に
 *   この端末で直した分（項目ごとの印が新しい方）を消さないため。
 * ★変わった顧客だけ書く（顧客は数千件あるので、全件の書き戻しは重い）。
 * ★見つからない手直しは**捨てない**（数だけ返して画面に出す）。
 */
export async function mergeSharedCustomerEdits(
  shared: SharedCustomerEdits,
): Promise<SharedMergeReport> {
  let report: SharedMergeReport = { applied: 0, unmatched: Object.keys(shared) };
  if (Object.keys(shared).length === 0) return { applied: 0, unmatched: [] };
  await withStore(STORE_CUSTOMERS, "readwrite", async (store) => {
    const existing = ((await request(store.getAll())) as Customer[])
      .filter((c) => c && typeof c.id === "string")
      .map(normalizeStoredCustomer);
    const result = applySharedCustomerEdits(existing, shared);
    result.customers.forEach((customer, i) => {
      if (customer !== existing[i]) store.put(customer);
    });
    report = { applied: result.changed, unmatched: result.unmatched };
  });
  return report;
}

/** 顧客データをまるごと消す (「顧客データを削除」ボタン) */
export async function clearCustomers(): Promise<void> {
  await withStore(STORE_CUSTOMERS, "readwrite", (s) => {
    s.clear();
  });
}
