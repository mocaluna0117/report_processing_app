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

const isEmptyValue = (value: unknown): boolean =>
  value === null || value === "" || (Array.isArray(value) && value.length === 0);

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
    // 引渡日の出どころ (報告書から反映) は取り込み直しても残す
    reportSync: previous.reportSync,
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
