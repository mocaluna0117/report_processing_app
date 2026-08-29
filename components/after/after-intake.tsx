"use client";

import { effectiveFields } from "@/lib/after/customer";
import type { Customer } from "@/lib/after/types";

/** コールセンターの受付内容を貼り付けて、1件の受付として登録する */
export function AfterIntake({
  customer,
  value,
  onChange,
  onSubmit,
  busy,
  error,
}: {
  customer: Customer | null;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
}) {
  const ready = customer !== null && value.trim() !== "" && !busy;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">
        受付内容
        <span className="ml-2 text-xs font-normal text-slate-500">
          コールセンターの記録を貼り付けると、不具合の事象だけを要約します
        </span>
      </h2>

      <p className="mt-1 text-sm text-slate-600">
        {customer ? (
          <>
            対象: <span className="font-medium">{effectiveFields(customer).ownerName || "(氏名なし)"}</span>
            <span className="ml-2 text-xs text-slate-500">
              {effectiveFields(customer).propertyName}
            </span>
          </>
        ) : (
          "先にお客様を選んでください"
        )}
      </p>

      <textarea
        value={value}
        rows={6}
        disabled={!customer || busy}
        placeholder={"例: 浴室の換気扇から異音がする。2階洋室の窓が閉まりにくい。"}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 貼り付けてすぐ登録できるように
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready) onSubmit();
        }}
        className="mt-2 w-full rounded-md border border-slate-300 p-2 text-sm leading-relaxed disabled:bg-slate-50"
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          要約のためにGemini APIへ送るのは、お客様の氏名・電話番号・住所を伏せ字にした受付内容だけです
        </p>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!ready}
          aria-busy={busy}
          className="whitespace-nowrap rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "登録中… (要約しています)" : "受付を登録"}
        </button>
      </div>

      {error && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </section>
  );
}
