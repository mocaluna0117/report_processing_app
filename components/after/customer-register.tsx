"use client";

import { useMemo } from "react";
import { BlockedReason } from "@/components/blocked-reason";
import { CUSTOMER_TEXT_FIELDS, EmailInput, slotLabel } from "@/components/after/customer-card";
import { effectiveFields } from "@/lib/after/customer";
import {
  type ManualDraft,
  developerFromPj,
  emptyManualDraft,
  findSamePj,
  isEmptyDraft,
  manualBlockedReason,
} from "@/lib/after/manual";
import { parsePhoneCell } from "@/lib/after/normalize";
import type { Customer } from "@/lib/after/types";

/** 登録欄の最初の入力欄 (「手入力で登録」を押したときにここへ移る) */
export const CUSTOMER_REGISTER_FIRST_INPUT = "customer-register-pj";

/** 電話番号を入力欄から離れたときに整える (読めなければ打ったまま) */
function tidyPhoneInput(value: string): string {
  const contact = parsePhoneCell(value);
  if (!contact) return value;
  return contact.relation ? `${contact.phone}（${contact.relation}）` : contact.phone;
}

/**
 * お客様を選んでいないときの「お客様の情報」。顧客データ (xlsx / csv) に無いお客様を手入力で登録する。
 * ★下書きは親が持つ (一覧で別のお客様を見に行っても、打ちかけの内容が消えないように)。
 */
export function CustomerRegister({
  customers,
  draft,
  onDraftChange,
  onSubmit,
  onSelect,
  busy,
  error,
}: {
  /** 同じ PJ のお客様がもういないかを見るため */
  customers: readonly Customer[];
  draft: ManualDraft;
  onDraftChange: (next: ManualDraft) => void;
  onSubmit: () => void;
  /** 同じ PJ のお客様を開く */
  onSelect: (id: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const blocked = manualBlockedReason(draft);
  const samePj = useMemo(() => findSamePj(customers, draft.pj), [customers, draft.pj]);
  const set = (patch: Partial<ManualDraft>) => onDraftChange({ ...draft, ...patch });
  const setSlot = (key: "phones" | "emails", index: number, value: string) => {
    const next: [string, string] = [...draft[key]];
    next[index] = value;
    set({ [key]: next });
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">
        お客様の情報
        <span className="ml-2 text-xs font-normal text-slate-500">
          左の一覧から選ぶと、内容を確認・修正できます。顧客データに無いお客様は、ここに入力して登録します
        </span>
      </h2>

      {/* ★form にしない。Enter (変換の確定など) で、書きかけのまま登録されないように */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {CUSTOMER_TEXT_FIELDS.map(({ key, label, placeholder, normalize }) => (
          <label key={key} className="block text-sm">
            <span className="font-medium">{label}</span>
            {key === "ownerName" && <span className="ml-1 text-[10px] text-red-700">必須</span>}
            <input
              id={key === "pj" ? CUSTOMER_REGISTER_FIRST_INPUT : undefined}
              value={draft[key]}
              placeholder={placeholder}
              onChange={(e) => set({ [key]: e.target.value })}
              onBlur={(e) => {
                const patch: Partial<ManualDraft> = {};
                const value = e.target.value;
                const tidy = normalize ? normalize(value) : value;
                if (tidy !== value) patch[key] = tidy;
                // PJ から事業者が決まるなら補う (事業者が空欄のときだけ。打った事業者は変えない)
                if (key === "pj" && !draft.developer.trim()) {
                  const developer = developerFromPj(value, draft.propertyName);
                  if (developer) patch.developer = developer;
                }
                if (Object.keys(patch).length > 0) set(patch);
              }}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
            {key === "pj" && samePj && (
              <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-amber-800">
                このPJのお客様はもういます ({effectiveFields(samePj).ownerName || "氏名なし"})
                <button
                  type="button"
                  onClick={() => onSelect(samePj.id)}
                  className="cursor-pointer underline hover:text-amber-950"
                >
                  → 開く
                </button>
              </span>
            )}
          </label>
        ))}

        {[0, 1].map((index) => (
          <label key={`phone-${index}`} className="block text-sm">
            <span className="font-medium">{slotLabel("連絡先", index)}</span>
            <input
              value={draft.phones[index]}
              placeholder="090-0000-1234"
              onChange={(e) => setSlot("phones", index, e.target.value)}
              onBlur={(e) => {
                const tidy = tidyPhoneInput(e.target.value);
                if (tidy !== e.target.value) setSlot("phones", index, tidy);
              }}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
          </label>
        ))}

        {[0, 1].map((index) => (
          <EmailInput
            key={`email-${index}`}
            label={slotLabel("メールアドレス", index)}
            value={draft.emails[index]}
            onChange={(value) => setSlot("emails", index, value)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <BlockedReason reason={busy ? null : blocked} className="mr-auto" />
        {!isEmptyDraft(draft) && (
          <button
            type="button"
            onClick={() => {
              if (confirm("入力した内容を消します。よろしいですか？")) onDraftChange(emptyManualDraft());
            }}
            className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            入力を消す
          </button>
        )}
        <button
          type="button"
          onClick={onSubmit}
          disabled={blocked !== null || busy}
          title={blocked ?? undefined}
          aria-busy={busy}
          className="whitespace-nowrap rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "登録中…" : "このお客様を登録"}
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
