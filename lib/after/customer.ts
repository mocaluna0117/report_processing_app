// Customer の読み書き (取り込み値と利用者の修正を重ねる)。純関数のみ。
import { buildSearchKey, normalizeQuery } from "@/lib/after/normalize";
import type { Customer, CustomerFields, CustomerIssue } from "@/lib/after/types";

/** 表示・出力に使う値 (取り込み値に利用者の修正を重ねたもの) */
export function effectiveFields(customer: Customer): CustomerFields {
  return { ...customer.imported, ...customer.edits };
}

/** まだ直されていない要確認だけを返す (その項目を編集したら解消とみなす) */
export function openIssues(customer: Customer): CustomerIssue[] {
  return customer.issues.filter(
    (issue) => issue.field === null || !(issue.field in customer.edits),
  );
}

export function needsReview(customer: Customer): boolean {
  return openIssues(customer).length > 0;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * 利用者の修正を反映する。
 * 取り込み値と同じに戻した項目は修正から外す (再取込で最新の値を受け取れるように)。
 */
export function applyEdits(
  customer: Customer,
  patch: Partial<CustomerFields>,
  now: number,
): Customer {
  const edits: Partial<CustomerFields> = { ...customer.edits };
  for (const [key, value] of Object.entries(patch) as [keyof CustomerFields, unknown][]) {
    if (sameValue(value, customer.imported[key])) delete edits[key];
    else Object.assign(edits, { [key]: value });
  }
  const next: Customer = { ...customer, edits, editedAt: now };
  return { ...next, searchKey: buildSearchKey(effectiveFields(next)) };
}

/** 取り込み値に戻す (修正をすべて捨てる) */
export function resetEdits(customer: Customer, now: number): Customer {
  return {
    ...customer,
    edits: {},
    editedAt: now,
    searchKey: buildSearchKey(customer.imported),
  };
}

/**
 * 再取込のときに、前の修正を新しい取り込み値へ引き継ぐ。
 * 取り込み値の方が修正と同じになったものは修正から外す。
 */
export function mergeImported(previous: Customer, incoming: Customer): Customer {
  const edits: Partial<CustomerFields> = {};
  for (const [key, value] of Object.entries(previous.edits) as [keyof CustomerFields, unknown][]) {
    if (!sameValue(value, incoming.imported[key])) Object.assign(edits, { [key]: value });
  }
  const merged: Customer = {
    ...incoming,
    edits,
    editedAt: previous.editedAt,
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
