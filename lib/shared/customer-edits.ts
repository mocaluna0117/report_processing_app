/**
 * 顧客データの「手直し」を2台のあいだで突き合わせる規則。純関数のみ。
 *
 * ★共有するのは**手直しだけ**（台帳の取り込み値・補完は置かない）。取り込み値は各自が同じ
 *   xlsx を取り込めば再現でき、補完は取り込みから決まるので、正本を二重に持たない。
 * ★突き合わせは**項目ごとの後勝ち**（editStamps）。レコード単位だと、定期点検の引渡日の反映と
 *   顛末書の監督・営業の反映が別の端末で走ったとき、片方が黙って消える。
 * ★印だけあって値が無いキーは「取り込み値に戻した」という意思表示（＝消す指示）。
 * ★どちらが先でも同じ結果になり（可換）、何度重ねても変わらない（冪等）ようにする。
 *   書き負けても、次の同期で相手の分が戻る（だからロックを持たない）。
 */
import { baseFields, effectiveFields } from "@/lib/after/customer";
import { buildSearchKey } from "@/lib/after/normalize";
import type {
  Customer,
  CustomerFields,
  CustomerSource,
  ReportSync,
  TenmatsuSync,
} from "@/lib/after/types";

type FieldKey = keyof CustomerFields;
type Stamps = Partial<Record<FieldKey, number>>;

/** 共有フォルダーに置く、顧客1件ぶんの手直し */
export interface SharedCustomerEntry {
  /** 取り込み元（名寄せを後から足すときの手がかり。個人情報ではない） */
  source: CustomerSource;
  /** 元の管理ID・物件番号（同上） */
  sourceKey: string;
  /** 利用者が直した値（直した項目だけ） */
  edits: Partial<CustomerFields>;
  /** 項目ごとに最後に手を入れた時刻。値の無いキー＝取り込み値に戻した印 */
  editStamps: Stamps;
  editedAt: number;
  reportSync?: ReportSync;
  tenmatsuSync?: TenmatsuSync;
}

/** 顧客の id → 手直し */
export type SharedCustomerEdits = Record<string, SharedCustomerEntry>;

export const emptyCustomerEdits = (): SharedCustomerEdits => ({});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStamps = (v: unknown): v is Stamps =>
  isRecord(v) && Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));

const isSyncLike = (v: unknown): boolean =>
  v === undefined || (isRecord(v) && typeof v.at === "number");

/** 1件ぶんの形か（合わないものは読み捨てる。当てようがないため） */
export function isSharedCustomerEntry(v: unknown): v is SharedCustomerEntry {
  if (!isRecord(v)) return false;
  return (
    (v.source === "dx" || v.source === "suketto") &&
    typeof v.sourceKey === "string" &&
    isRecord(v.edits) &&
    isStamps(v.editStamps) &&
    typeof v.editedAt === "number" &&
    isSyncLike(v.reportSync) &&
    isSyncLike(v.tenmatsuSync)
  );
}

/** ファイルの中身の形か（1件ずつ確かめ、形の違うものは落とす） */
export function isSharedCustomerEdits(v: unknown): v is SharedCustomerEdits {
  return isRecord(v) && Object.values(v).every(isSharedCustomerEntry);
}

/** 形の違う1件を落として読む（1件の不備で全部を捨てないため） */
export function pickSharedCustomerEdits(v: unknown): SharedCustomerEdits {
  if (!isRecord(v)) return {};
  const out: SharedCustomerEdits = {};
  for (const [id, entry] of Object.entries(v)) {
    if (isSharedCustomerEntry(entry)) out[id] = entry;
  }
  return out;
}

/** その項目に手を入れた時刻。印が無い古いデータは editedAt を印とみなす */
function stampOf(entry: SharedCustomerEntry, key: FieldKey): number {
  const stamp = entry.editStamps[key];
  if (typeof stamp === "number") return stamp;
  return key in entry.edits ? entry.editedAt : Number.NEGATIVE_INFINITY;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 同時刻で並んだときの決め方（どちらが先でも同じ結果になるように） */
function pickTied(a: unknown, aHas: boolean, b: unknown, bHas: boolean): { has: boolean; value: unknown } {
  if (aHas && !bHas) return { has: true, value: a };
  if (bHas && !aHas) return { has: true, value: b };
  if (!aHas && !bHas) return { has: false, value: undefined };
  if (sameValue(a, b)) return { has: true, value: a };
  // 中身で決める（文字列の大きい方）。どちらを採っても情報としては等価
  return JSON.stringify(a) > JSON.stringify(b) ? { has: true, value: a } : { has: true, value: b };
}

/** 出どころの記録は新しい方。片方にしか無ければそれを残す（表示用なので残して害が無い） */
function mergeSync<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** 文字列を決定的に選ぶ（同じ id なら普通は同じ値なので、違うときの保険） */
const pickText = (a: string, b: string): string => (a === b ? a : a > b ? a : b);

/** 顧客1件の手直しを突き合わせる（可換・冪等） */
export function mergeCustomerEntry(
  a: SharedCustomerEntry,
  b: SharedCustomerEntry,
): SharedCustomerEntry {
  const keys = new Set<FieldKey>([
    ...(Object.keys(a.edits) as FieldKey[]),
    ...(Object.keys(a.editStamps) as FieldKey[]),
    ...(Object.keys(b.edits) as FieldKey[]),
    ...(Object.keys(b.editStamps) as FieldKey[]),
  ]);
  const edits: Partial<CustomerFields> = {};
  const editStamps: Stamps = {};
  for (const key of [...keys].sort()) {
    const sa = stampOf(a, key);
    const sb = stampOf(b, key);
    const stamp = Math.max(sa, sb);
    const chosen =
      sa > sb
        ? { has: key in a.edits, value: a.edits[key] }
        : sb > sa
          ? { has: key in b.edits, value: b.edits[key] }
          : pickTied(a.edits[key], key in a.edits, b.edits[key], key in b.edits);
    if (Number.isFinite(stamp)) editStamps[key] = stamp;
    if (chosen.has) Object.assign(edits, { [key]: chosen.value });
  }
  const merged: SharedCustomerEntry = {
    source: a.source === b.source ? a.source : pickText(a.source, b.source) === a.source ? a.source : b.source,
    sourceKey: pickText(a.sourceKey, b.sourceKey),
    edits,
    editStamps,
    editedAt: Math.max(a.editedAt, b.editedAt),
  };
  const reportSync = mergeSync(a.reportSync, b.reportSync);
  const tenmatsuSync = mergeSync(a.tenmatsuSync, b.tenmatsuSync);
  if (reportSync) merged.reportSync = reportSync;
  if (tenmatsuSync) merged.tenmatsuSync = tenmatsuSync;
  return merged;
}

/** 2つの束を突き合わせる（id の和集合。可換・冪等） */
export function mergeCustomerEdits(
  a: SharedCustomerEdits,
  b: SharedCustomerEdits,
): SharedCustomerEdits {
  const out: SharedCustomerEdits = {};
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = a[id];
    const right = b[id];
    out[id] = left && right ? mergeCustomerEntry(left, right) : (left ?? right);
  }
  return out;
}

/** 手直しのある顧客だけを取り出す（何も直していない顧客は載せない） */
export function extractCustomerEdits(customers: readonly Customer[]): SharedCustomerEdits {
  const out: SharedCustomerEdits = {};
  for (const customer of customers) {
    const editKeys = Object.keys(customer.edits) as FieldKey[];
    const stampKeys = Object.keys(customer.editStamps ?? {}) as FieldKey[];
    if (editKeys.length === 0 && stampKeys.length === 0 && !customer.reportSync && !customer.tenmatsuSync) {
      continue;
    }
    // 印の無い古いデータは editedAt を印とみなして載せる（載せた時点で形をそろえる）
    const editStamps: Stamps = { ...customer.editStamps };
    for (const key of editKeys) {
      if (typeof editStamps[key] !== "number") editStamps[key] = customer.editedAt ?? 0;
    }
    const entry: SharedCustomerEntry = {
      source: customer.source,
      sourceKey: customer.sourceKey,
      edits: { ...customer.edits },
      editStamps,
      editedAt: customer.editedAt ?? 0,
    };
    if (customer.reportSync) entry.reportSync = customer.reportSync;
    if (customer.tenmatsuSync) entry.tenmatsuSync = customer.tenmatsuSync;
    out[customer.id] = entry;
  }
  return out;
}

/**
 * 突き合わせた手直しを顧客に当てる。
 * ★取り込み値（補完を含む）と同じになった項目は修正から外す（mergeImported と同じ規則）。
 * ★中身が変わらなければ**同じ参照を返す**（写しに書き直さずに済む）。
 */
export function withSharedEntry(customer: Customer, entry: SharedCustomerEntry): Customer {
  const base = baseFields(customer);
  const edits: Partial<CustomerFields> = {};
  for (const [key, value] of Object.entries(entry.edits) as [FieldKey, unknown][]) {
    if (!sameValue(value, base[key])) Object.assign(edits, { [key]: value });
  }
  const next: Customer = {
    ...customer,
    edits,
    editedAt: entry.editedAt,
  };
  if (Object.keys(entry.editStamps).length > 0) next.editStamps = entry.editStamps;
  else delete next.editStamps;
  if (entry.reportSync) next.reportSync = entry.reportSync;
  else delete next.reportSync;
  if (entry.tenmatsuSync) next.tenmatsuSync = entry.tenmatsuSync;
  else delete next.tenmatsuSync;
  const withKey: Customer = { ...next, searchKey: buildSearchKey(effectiveFields(next)) };
  return sameValue(withKey, customer) ? customer : withKey;
}

export interface ApplySharedResult {
  customers: Customer[];
  /** 中身が変わった顧客の数 */
  changed: number;
  /** この端末の顧客データに見つからなかった手直しの id */
  unmatched: string[];
}

/**
 * 手直しの束を顧客一覧に当てる。
 * ★見つからない手直しは**捨てずに数える**（同じ xlsx を取り込めば結び付くので、
 *   ファイルからは消さない。助っ人クラウドの id は取り込み内容で変わるため）。
 */
export function applySharedCustomerEdits(
  customers: readonly Customer[],
  shared: SharedCustomerEdits,
): ApplySharedResult {
  const seen = new Set<string>();
  let changed = 0;
  const next = customers.map((customer) => {
    const entry = shared[customer.id];
    if (!entry) return customer;
    seen.add(customer.id);
    const applied = withSharedEntry(customer, entry);
    if (applied !== customer) changed += 1;
    return applied;
  });
  const unmatched = Object.keys(shared).filter((id) => !seen.has(id));
  return { customers: next, changed, unmatched };
}
