// Customer の読み書き (取り込み値と利用者の修正を重ねる)。純関数のみ。
import { buildSearchKey, normalizeQuery } from "@/lib/after/normalize";
import type { Customer, CustomerFields, CustomerIssue } from "@/lib/after/types";

/**
 * 取り込み値に補完を重ねたもの (利用者の修正は含まない)。
 * 補完は「点検保守台帳が空欄だったので助っ人クラウドから補った値」なので、取り込み値の一部として扱う。
 */
export function baseFields(customer: Customer): CustomerFields {
  return { ...customer.imported, ...customer.supplements };
}

/**
 * 項目を増やしたときに、古い保存データへ当てる既定値。
 * IndexedDB は保存したときの形をそのまま返すので、後から増やした項目は
 * 実体が undefined になる。**新しい項目を足したらここにも足すこと。**
 */
const STORED_DEFAULTS = {
  postalCode: "",
  supervisor: "",
} as const satisfies Partial<CustomerFields>;

/**
 * 保存済みの顧客を今の形に揃える (何度通しても同じ結果)。
 * 足りない項目を空値で埋め、埋めたときだけ検索キーを作り直す。
 * ★顧客を読み出すところすべてで通すこと (loadCustomers だけでは漏れる)。
 */
export function normalizeStoredCustomer(customer: Customer): Customer {
  const keys = Object.keys(STORED_DEFAULTS) as (keyof typeof STORED_DEFAULTS)[];
  const missing = keys.filter((key) => customer.imported[key] === undefined);
  if (missing.length === 0) return customer;
  const imported = { ...customer.imported };
  for (const key of missing) imported[key] = STORED_DEFAULTS[key];
  const next: Customer = { ...customer, imported };
  return { ...next, searchKey: buildSearchKey(effectiveFields(next)) };
}

/** 表示・出力に使う値 (取り込み値・補完・利用者の修正をこの順に重ねたもの) */
export function effectiveFields(customer: Customer): CustomerFields {
  return { ...customer.imported, ...customer.supplements, ...customer.edits };
}

/** まだ直されていない要確認だけを返す (その項目を編集・補完したら解消とみなす) */
export function openIssues(customer: Customer): CustomerIssue[] {
  return customer.issues.filter(
    (issue) =>
      issue.field === null ||
      !(issue.field in customer.edits || issue.field in (customer.supplements ?? {})),
  );
}

export function needsReview(customer: Customer): boolean {
  return openIssues(customer).length > 0;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// undefined も空として扱う。項目を増やす前に保存された顧客は、その項目を
// 持っていない (型では string でも実体は undefined)。ここで空と見なさないと、
// 「台帳が空欄なら助っ人クラウドから補う」が古いレコードに効かなくなる
const isEmptyValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/**
 * 補完を差し替える (助っ人クラウドから補った値)。
 * 取り込み値に入っている項目は補完しない — 点検保守台帳が正なので、台帳の値が常に勝つ。
 */
export function withSupplements(customer: Customer, values: Partial<CustomerFields>): Customer {
  const supplements: Partial<CustomerFields> = {};
  for (const [key, value] of Object.entries(values) as [keyof CustomerFields, unknown][]) {
    if (isEmptyValue(value) || !isEmptyValue(customer.imported[key])) continue;
    Object.assign(supplements, { [key]: value });
  }
  // 変化が無ければ同じオブジェクトを返す (保存が要るかを参照の比較で判定できるように)
  if (sameValue(supplements, customer.supplements ?? {})) return customer;
  const next: Customer = { ...customer, supplements };
  if (Object.keys(supplements).length === 0) delete next.supplements;
  return { ...next, searchKey: buildSearchKey(effectiveFields(next)) };
}

/**
 * 利用者の修正を反映する。
 * 取り込み値 (補完を含む) と同じに戻した項目は修正から外す (再取込で最新の値を受け取れるように)。
 */
export function applyEdits(
  customer: Customer,
  patch: Partial<CustomerFields>,
  now: number,
): Customer {
  const base = baseFields(customer);
  const edits: Partial<CustomerFields> = { ...customer.edits };
  for (const [key, value] of Object.entries(patch) as [keyof CustomerFields, unknown][]) {
    if (sameValue(value, base[key])) delete edits[key];
    else Object.assign(edits, { [key]: value });
  }
  const next: Customer = { ...customer, edits, editedAt: now };
  return { ...next, searchKey: buildSearchKey(effectiveFields(next)) };
}

/**
 * 写真報告書 (定期点検) の引渡日を利用者の修正として反映し、出どころを残す。
 * 修正として書くので、顧客データを取り込み直しても残る。
 */
export function applyReportHandoverDate(
  customer: Customer,
  date: string,
  pj: string | null,
  now: number,
): Customer {
  return {
    ...applyEdits(customer, { handoverDate: date }, now),
    reportSync: { handoverDate: date, at: now, pj },
  };
}

/**
 * 顛末書の監督・営業を利用者の修正として反映し、出どころを残す。
 * 修正として書くので、顧客データを取り込み直しても残る
 * (台帳に値が入れば applyEdits の規則で自然に外れる)。
 */
export function applyTenmatsuStaff(
  customer: Customer,
  patch: { supervisor?: string; salesRep?: string },
  pj: string | null,
  now: number,
): Customer {
  const next = applyEdits(customer, patch, now);
  return { ...next, tenmatsuSync: { ...patch, at: now, pj } };
}

/** その項目が顛末書から反映されたものか (顧客カードの表示に使う) */
export function isTenmatsuStaff(
  customer: Customer,
  field: "supervisor" | "salesRep",
): boolean {
  const sync = customer.tenmatsuSync;
  if (!sync) return false;
  const value = sync[field];
  return value !== undefined && customer.edits[field] === value;
}

/**
 * 顛末書から入れた監督・営業を取り消す (修正からキーごと外す)。
 * ★applyEdits で空文字に戻してはいけない。項目を増やす前に保存された顧客は
 *   取り込み値が undefined なので空文字と一致せず、修正が残り続けてしまう。
 */
export function revertTenmatsuStaff(
  customer: Customer,
  fields: readonly ("supervisor" | "salesRep")[],
  now: number,
): Customer {
  const edits: Partial<CustomerFields> = { ...customer.edits };
  for (const field of fields) delete edits[field];
  const next: Customer = { ...customer, edits, editedAt: now };
  delete next.tenmatsuSync;
  return { ...next, searchKey: buildSearchKey(effectiveFields(next)) };
}

/** 引渡日が写真報告書から反映されたものか (顧客カードの表示に使う) */
export function isReportHandover(customer: Customer): boolean {
  return (
    customer.reportSync !== undefined &&
    customer.edits.handoverDate === customer.reportSync.handoverDate
  );
}

/** 取り込み値 (補完を含む) に戻す (修正をすべて捨てる) */
export function resetEdits(customer: Customer, now: number): Customer {
  return {
    ...customer,
    edits: {},
    editedAt: now,
    searchKey: buildSearchKey(baseFields(customer)),
  };
}

/**
 * 再取込のときに、前の修正・補完を新しい取り込み値へ引き継ぐ。
 * 取り込み値の方が修正・補完と同じ役目を果たすようになったものは外す。
 */
export function mergeImported(previous: Customer, incoming: Customer): Customer {
  // 補完は「取り込み値が空欄のときだけ」なので、値が入ったものはここで落ちる
  const supplemented = withSupplements(incoming, previous.supplements ?? {});
  const base = baseFields(supplemented);
  const edits: Partial<CustomerFields> = {};
  for (const [key, value] of Object.entries(previous.edits) as [keyof CustomerFields, unknown][]) {
    if (!sameValue(value, base[key])) Object.assign(edits, { [key]: value });
  }
  const merged: Customer = {
    ...supplemented,
    edits,
    editedAt: previous.editedAt,
    // 出どころ (報告書から引渡日 / 顛末書から監督・営業) は取り込み直しても残す
    reportSync: previous.reportSync,
    tenmatsuSync: previous.tenmatsuSync,
  };
  return { ...merged, searchKey: buildSearchKey(effectiveFields(merged)) };
}

/** 検索語 (AND条件) に一致するか */
export function matchesQuery(customer: Customer, terms: string[]): boolean {
  return terms.every((term) => customer.searchKey.includes(term));
}

/** 顧客一覧から検索する (上限件数まで) */
export function searchCustomers(
  customers: Customer[],
  query: string,
  limit = 50,
): { matched: Customer[]; total: number } {
  const terms = normalizeQuery(query);
  if (terms.length === 0) return { matched: customers.slice(0, limit), total: customers.length };
  const matched: Customer[] = [];
  let total = 0;
  for (const customer of customers) {
    if (!matchesQuery(customer, terms)) continue;
    total += 1;
    if (matched.length < limit) matched.push(customer);
  }
  return { matched, total };
}
