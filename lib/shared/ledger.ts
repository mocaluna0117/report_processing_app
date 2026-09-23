/**
 * 顧客データの**台帳そのもの**を2台で分け合う規則。純関数のみ。
 *
 * ★これまでは xlsx / csv を共有フォルダーに置いて、各自が取り込んでいた。
 *   それだと点検保守台帳の差分ファイルが月ごとに溜まり、2人目は全部を読むことになる。
 *   取り込んだあとの**台帳そのもの**を1つのファイルに書けば、追加があっても1つのまま。
 * ★**id は作り直さない。** 取り込んだときに作って保存してある id をそのまま運ぶので、
 *   助っ人クラウドの id（取り込み内容のハッシュ）も必ず一致し、手直しが確実に結び付く。
 * ★手直し（edits）はここに入れない。別のファイル（顧客の手直し.json）で分け合う。
 *   台帳は取り込んだときにしか変わらないが、手直しは直すたびに変わるため、分けておく。
 * ★補完（supplements）・検索語（searchKey）も入れない。取り込みから決まるので、当てるときに作り直す。
 */
import type { Customer, CustomerFields, CustomerIssue, CustomerSource } from "@/lib/after/types";

/** 共有フォルダーに置く、顧客1件ぶんの取り込み値 */
export interface LedgerCustomer {
  id: string;
  source: CustomerSource;
  sourceKey: string;
  sourceRow: number;
  imported: CustomerFields;
  issues: CustomerIssue[];
  corporate: boolean;
  importedAt: number;
}

export interface LedgerSource {
  /** その取り込み元をいつ取り込んだか（いちばん新しい importedAt） */
  at: number;
  customers: LedgerCustomer[];
}

export type SharedLedger = Partial<Record<CustomerSource, LedgerSource>>;

export const emptyLedger = (): SharedLedger => ({});

const SOURCES: readonly CustomerSource[] = ["suketto", "dx"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isLedgerCustomer(v: unknown): v is LedgerCustomer {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    (v.source === "suketto" || v.source === "dx") &&
    typeof v.sourceKey === "string" &&
    typeof v.sourceRow === "number" &&
    isRecord(v.imported) &&
    Array.isArray(v.issues) &&
    typeof v.corporate === "boolean" &&
    typeof v.importedAt === "number"
  );
}

/**
 * ファイルの中身を読む。
 * ★まるごと形が違えば null（＝読めないファイルとして止める）。
 *   1件だけ形が違うものは落として、ほかは活かす。
 */
export function pickSharedLedger(v: unknown): SharedLedger | null {
  if (!isRecord(v)) return null;
  const out: SharedLedger = {};
  for (const source of SOURCES) {
    const found = v[source];
    if (!isRecord(found) || !Array.isArray(found.customers)) continue;
    out[source] = {
      at: typeof found.at === "number" && Number.isFinite(found.at) ? found.at : 0,
      customers: found.customers.filter(isLedgerCustomer),
    };
  }
  return out;
}

const latestImportedAt = (customers: readonly LedgerCustomer[]): number =>
  customers.reduce((max, c) => (c.importedAt > max ? c.importedAt : max), 0);

/** この端末の顧客データから、共有に載せる形を作る */
export function extractLedger(customers: readonly Customer[]): SharedLedger {
  const out: SharedLedger = {};
  for (const source of SOURCES) {
    const mine = customers
      .filter((c) => c.source === source)
      .map(
        (c): LedgerCustomer => ({
          id: c.id,
          source: c.source,
          sourceKey: c.sourceKey,
          sourceRow: c.sourceRow,
          imported: c.imported,
          issues: c.issues,
          corporate: c.corporate,
          importedAt: c.importedAt,
        }),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (mine.length > 0) out[source] = { at: latestImportedAt(mine), customers: mine };
  }
  return out;
}

/** 同じ id が並んだときの決め方（どちらが先でも同じ結果になるように） */
const newer = (a: LedgerCustomer, b: LedgerCustomer): LedgerCustomer => {
  if (a.importedAt !== b.importedAt) return a.importedAt > b.importedAt ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
};

/**
 * 2つの台帳を突き合わせる（可換・冪等）。**取り込み元ごとに規則が違う**。
 *
 * ★点検保守台帳は**物件番号で足し込む**取り込み元なので、id の和集合をとる
 *   （同じ id は新しい方）。月ごとの差分を片方だけが取り込んでいても、消えない。
 * ★助っ人クラウドは**丸ごと入れ替える**取り込み元なので、新しく取り込んだ方の一式を採る。
 *   和集合にすると、消したはずの行が相手から戻ってきてしまう。
 */
export function mergeSharedLedger(a: SharedLedger, b: SharedLedger): SharedLedger {
  const out: SharedLedger = {};

  const dx = mergeAdditive(a.dx, b.dx);
  if (dx) out.dx = dx;

  const suketto = pickReplacing(a.suketto, b.suketto);
  if (suketto) out.suketto = suketto;

  return out;
}

function mergeAdditive(a?: LedgerSource, b?: LedgerSource): LedgerSource | undefined {
  if (!a) return b;
  if (!b) return a;
  const byId = new Map<string, LedgerCustomer>();
  for (const customer of [...a.customers, ...b.customers]) {
    const found = byId.get(customer.id);
    byId.set(customer.id, found ? newer(found, customer) : customer);
  }
  const customers = [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { at: Math.max(a.at, b.at), customers };
}

function pickReplacing(a?: LedgerSource, b?: LedgerSource): LedgerSource | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  // 同じ時刻なら、中身で決める（どちらを採っても情報としては等価）
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** その取り込み元について、この端末の中身と同じか（同じなら重い書き戻しをしない） */
export function sameLedgerSource(mine?: LedgerSource, theirs?: LedgerSource): boolean {
  if (!mine || !theirs) return mine === theirs;
  return JSON.stringify(mine.customers) === JSON.stringify(theirs.customers);
}

/** 共有の台帳を、取り込みに渡せる形（Customer）に戻す */
export function toCustomers(source: LedgerSource): Customer[] {
  return source.customers.map(
    (c): Customer => ({
      id: c.id,
      source: c.source,
      sourceKey: c.sourceKey,
      sourceRow: c.sourceRow,
      imported: c.imported,
      edits: {},
      issues: c.issues,
      corporate: c.corporate,
      // ★検索語と補完は取り込みのときに作り直される（mergeImported / withSupplements）
      searchKey: "",
      importedAt: c.importedAt,
      editedAt: null,
    }),
  );
}

/** 件数（画面に出す） */
export function ledgerCount(ledger: SharedLedger): number {
  return SOURCES.reduce((n, source) => n + (ledger[source]?.customers.length ?? 0), 0);
}
