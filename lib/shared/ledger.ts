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
 * ★手入力で登録したお客様（manual）もここに載せる。元のファイルが無いので、2台目へ届く道はこれだけ。
 *   1件ずつ消せるので、**消した印（deleted）も一緒に運ぶ**（印が無いと、相手のファイルから戻ってくる）。
 */
import { buildSearchKey } from "@/lib/after/normalize";
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
  /**
   * 消した印（顧客の id → 消した時刻）。手入力のお客様（manual）だけが持つ。
   * ★印のある id は、どちらの端末にあっても載せない（id は登録のたびに作るので、同じ id が
   *   登録し直されることは無い。時刻は比べずに、印があれば消す）。
   */
  deleted?: Record<string, number>;
}

export type SharedLedger = Partial<Record<CustomerSource, LedgerSource>>;

export const emptyLedger = (): SharedLedger => ({});

const SOURCES: readonly CustomerSource[] = ["suketto", "dx", "manual"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isLedgerCustomer(v: unknown): v is LedgerCustomer {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    (v.source === "suketto" || v.source === "dx" || v.source === "manual") &&
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
    // ★ほかの取り込み元の顧客が紛れ込んでいたら落とす（規則の違う束に混ざらないように）
    out[source] = {
      at: typeof found.at === "number" && Number.isFinite(found.at) ? found.at : 0,
      customers: found.customers.filter(
        (c): c is LedgerCustomer => isLedgerCustomer(c) && c.source === source,
      ),
    };
    const deleted = source === "manual" ? pickDeleted(found.deleted) : {};
    if (Object.keys(deleted).length > 0) out[source].deleted = deleted;
  }
  return out;
}

function pickDeleted(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [id, at] of Object.entries(v)) {
    if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

const latestImportedAt = (customers: readonly LedgerCustomer[]): number =>
  customers.reduce((max, c) => (c.importedAt > max ? c.importedAt : max), 0);

/**
 * この端末の顧客データから、共有に載せる形を作る。
 * manualDeleted: この端末で消した手入力のお客様の印（lib/after/customer-store.ts が保存している）
 */
export function extractLedger(
  customers: readonly Customer[],
  manualDeleted: Readonly<Record<string, number>> = {},
): SharedLedger {
  const out: SharedLedger = {};
  for (const source of SOURCES) {
    const mine = customers
      .filter((c) => c.source === source && !(source === "manual" && c.id in manualDeleted))
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
  if (Object.keys(manualDeleted).length > 0) {
    out.manual = {
      at: out.manual?.at ?? 0,
      customers: out.manual?.customers ?? [],
      deleted: sortedMarks(manualDeleted),
    };
  }
  return out;
}

/** 印を id の順に並べる（中身が同じなら同じ JSON になるように） */
function sortedMarks(marks: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(marks).sort()) out[id] = marks[id];
  return out;
}

/** 消した印を重ねる（id ごとに新しい時刻。可換・冪等） */
export function mergeDeletedMarks(
  a: Readonly<Record<string, number>> = {},
  b: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [id, at] of Object.entries(b)) merged[id] = Math.max(merged[id] ?? at, at);
  return sortedMarks(merged);
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
 * ★手入力は**足し込んでから、消した印のある id を落とす**。2台で別々に登録しても両方残り、
 *   片方で消せばもう片方からも消える。
 */
export function mergeSharedLedger(a: SharedLedger, b: SharedLedger): SharedLedger {
  const out: SharedLedger = {};

  const dx = mergeAdditive(a.dx, b.dx);
  if (dx) out.dx = dx;

  const suketto = pickReplacing(a.suketto, b.suketto);
  if (suketto) out.suketto = suketto;

  const manual = mergeManual(a.manual, b.manual);
  if (manual) out.manual = manual;

  return out;
}

function mergeManual(a?: LedgerSource, b?: LedgerSource): LedgerSource | undefined {
  const union = mergeAdditive(a, b);
  if (!union) return undefined;
  const deleted = mergeDeletedMarks(a?.deleted, b?.deleted);
  const out: LedgerSource = {
    at: union.at,
    customers: union.customers.filter((c) => !(c.id in deleted)),
  };
  if (Object.keys(deleted).length > 0) out.deleted = deleted;
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
      // ★取り込み値から作っておく。初めて届いた顧客は、取り込みの道（withSupplements）で
      //   補完が無ければ作り直されないので、空のままだと検索に掛からない
      //   （手直しのある顧客は mergeImported が手直し込みで作り直す）
      searchKey: buildSearchKey(c.imported),
      importedAt: c.importedAt,
      editedAt: null,
    }),
  );
}

/** 件数（画面に出す） */
export function ledgerCount(ledger: SharedLedger): number {
  return SOURCES.reduce((n, source) => n + (ledger[source]?.customers.length ?? 0), 0);
}
