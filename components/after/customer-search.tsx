"use client";

import { useDeferredValue, useMemo } from "react";
import { effectiveFields, needsReview, searchCustomers } from "@/lib/after/customer";
import type { Customer } from "@/lib/after/types";

const SOURCE_BADGE: Record<Customer["source"], string> = {
  suketto: "助っ人",
  dx: "DX",
};

/** 顧客の検索と選択 (氏名・カナ・PJ・物件名・住所・電話で探せる) */
export function CustomerSearch({
  customers,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  reviewOnly,
  onReviewOnlyChange,
  limit = 50,
}: {
  customers: Customer[];
  query: string;
  onQueryChange: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  reviewOnly: boolean;
  onReviewOnlyChange: (value: boolean) => void;
  limit?: number;
}) {
  // 入力のたびに全件を走査するので、描画は遅延させて入力を軽く保つ
  const deferredQuery = useDeferredValue(query);
  const pool = useMemo(
    () => (reviewOnly ? customers.filter(needsReview) : customers),
    [customers, reviewOnly],
  );
  const { matched, total } = useMemo(
    () => searchCustomers(pool, deferredQuery, limit),
    [pool, deferredQuery, limit],
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <label className="block text-sm font-medium" htmlFor="customer-search">
        お客様を探す
      </label>
      <input
        id="customer-search"
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="氏名・カナ・PJ・物件名・住所・電話番号"
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span aria-live="polite">
          {total.toLocaleString()}件が一致
          {total > matched.length && ` (上位${matched.length}件を表示)`}
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={reviewOnly}
            onChange={(e) => onReviewOnlyChange(e.target.checked)}
          />
          要確認のみ
        </label>
      </div>

      <ul className="mt-2 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
        {matched.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-slate-400">
            該当するお客様がいません
          </li>
        )}
        {matched.map((customer) => {
          const fields = effectiveFields(customer);
          const active = customer.id === selectedId;
          return (
            <li key={customer.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(customer.id)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                  active ? "bg-blue-50" : "bg-white"
                }`}
              >
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{fields.ownerName || "(氏名なし)"}</span>
                  {fields.ownerKana && (
                    <span className="text-xs text-slate-500">{fields.ownerKana}</span>
                  )}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                    {SOURCE_BADGE[customer.source]}
                  </span>
                  {needsReview(customer) && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900">
                      要確認
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-slate-500">
                  {[fields.pj ?? "PJなし", fields.propertyName, fields.address]
                    .filter(Boolean)
                    .join(" / ")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
