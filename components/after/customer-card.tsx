"use client";

import { useState } from "react";
import {
  effectiveFields,
  isReportHandover,
  isTenmatsuStaff,
  openIssues,
} from "@/lib/after/customer";
import type { Customer, CustomerFields } from "@/lib/after/types";
import {
  isEmail,
  parsePhoneCell,
  tidyDateInput,
  tidyNameInput,
  tidyPostalInput,
} from "@/lib/after/normalize";

export type CustomerTextField =
  | "pj"
  | "developer"
  | "propertyName"
  | "ownerName"
  | "ownerKana"
  | "postalCode"
  | "address"
  | "handoverDate"
  | "supervisor"
  | "salesRep";

/**
 * お客様の情報の文字の項目 (この欄と、手入力で登録する欄で同じものを使う)。
 * nullable な項目は空欄を null にする (未設定と空文字を区別するため)。
 * normalize は入力欄から離れたときだけ当てる (打っている途中に整えると入力できなくなる)。
 */
export const CUSTOMER_TEXT_FIELDS: readonly {
  key: CustomerTextField;
  label: string;
  placeholder?: string;
  nullable?: boolean;
  normalize?: (value: string) => string;
}[] = [
  { key: "pj", label: "PJ", placeholder: "2101230101", nullable: true },
  { key: "developer", label: "事業者", placeholder: "大和ハウス工業", nullable: true },
  { key: "propertyName", label: "物件名称" },
  { key: "ownerName", label: "お客様氏名", placeholder: "山田 太郎", normalize: tidyNameInput },
  {
    key: "ownerKana",
    label: "お客様氏名 (カナ)",
    placeholder: "ヤマダ タロウ",
    normalize: tidyNameInput,
  },
  // 7桁として読めたときだけ 123-4567 に整える。読めない値はそのまま残す
  { key: "postalCode", label: "郵便番号", placeholder: "123-4567", normalize: tidyPostalInput },
  { key: "address", label: "住所" },
  // 日付として読めたときだけ 2025/09/26 の形に整える (2025/9/26・令和7年9月26日 なども読む)
  {
    key: "handoverDate",
    label: "引渡日",
    placeholder: "2025/09/26",
    nullable: true,
    normalize: tidyDateInput,
  },
  { key: "supervisor", label: "監督", placeholder: "山田 太郎" },
  { key: "salesRep", label: "営業", placeholder: "佐藤 花子" },
];

/** 連絡先①② / メールアドレス①② の見出し */
export const slotLabel = (label: string, index: number): string =>
  `${label}${index === 0 ? "①" : "②"}`;

/**
 * メールアドレスの入力欄。
 * ★形式の誤りは入力欄から離れてから知らせる (打っている途中に毎回黄色くしない)。
 */
export function EmailInput({
  label,
  value,
  onChange,
  issue,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 取り込みで見つかった誤り (取り込み元の値が不正だったなど) */
  issue?: string;
  disabled?: boolean;
}) {
  const [typing, setTyping] = useState(false);
  const invalid = !typing && value.trim() !== "" && !isEmail(value);
  const message = invalid ? "メールアドレスの形式が正しくありません" : issue;
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <input
        type="text"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={disabled ? "①を入れると使えます" : "taro@example.com"}
        disabled={disabled}
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded border px-2 py-1.5 text-sm disabled:bg-slate-50 ${
          message ? "border-amber-300 bg-amber-50" : "border-slate-300 bg-white"
        }`}
      />
      {message && <span className="mt-0.5 block text-xs text-amber-800">{message}</span>}
    </label>
  );
}

/** 選んだお客様の内容。取り込みで判断できなかった項目はここで直す (再取り込みしても残る) */
export function CustomerCard({
  customer,
  onChange,
  onReset,
  onDelete,
}: {
  customer: Customer;
  onChange: (patch: Partial<CustomerFields>) => void;
  onReset: () => void;
  /** 手入力で登録したお客様だけ渡す (取り込んだお客様は、ファイルを取り込み直すと戻るので消さない) */
  onDelete?: () => void;
}) {
  const fields = effectiveFields(customer);
  const issues = openIssues(customer);
  const issueOf = (key: keyof CustomerFields) => issues.find((i) => i.field === key)?.message;
  const edited = (key: keyof CustomerFields) => key in customer.edits;
  // 点検保守台帳が空欄だったので助っ人クラウドから補った項目
  const supplemented = (key: keyof CustomerFields) =>
    !edited(key) && key in (customer.supplements ?? {});
  const manual = customer.source === "manual";

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">
          お客様の情報
          <span className="ml-2 text-xs font-normal text-slate-500">
            {manual
              ? "手入力で登録したお客様です。直した内容は保存されます"
              : "直した内容は保存され、顧客データを取り込み直しても残ります"}
          </span>
        </h2>
        <div className="flex flex-wrap justify-end gap-2">
          {Object.keys(customer.edits).length > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {manual ? "登録した内容に戻す" : "取り込んだ内容に戻す"}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="whitespace-nowrap rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              このお客様を削除
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {CUSTOMER_TEXT_FIELDS.map(({ key, label, placeholder, nullable, normalize }) => {
          const issue = issueOf(key);
          return (
            <label key={key} className="block text-sm">
              <span className="font-medium">{label}</span>
              {edited(key) &&
                (key === "handoverDate" && isReportHandover(customer) ? (
                  <span className="ml-1 text-[10px] text-blue-700">
                    定期点検の報告書から更新
                  </span>
                ) : (key === "supervisor" || key === "salesRep") &&
                  isTenmatsuStaff(customer, key) ? (
                  <span className="ml-1 text-[10px] text-blue-700">顛末書から反映</span>
                ) : (
                  <span className="ml-1 text-[10px] text-blue-700">手直し済み</span>
                ))}
              {supplemented(key) && (
                <span className="ml-1 text-[10px] text-slate-500">助っ人クラウドから補完</span>
              )}
              <input
                value={(fields[key] as string | null) ?? ""}
                placeholder={placeholder}
                onChange={(e) =>
                  onChange({
                    [key]: nullable ? e.target.value || null : e.target.value,
                  } as Partial<CustomerFields>)
                }
                onBlur={(e) => {
                  if (!normalize) return;
                  const tidy = normalize(e.target.value);
                  if (tidy !== e.target.value) {
                    onChange({ [key]: tidy } as Partial<CustomerFields>);
                  }
                }}
                className={`mt-1 w-full rounded border px-2 py-1.5 text-sm ${
                  issue ? "border-amber-300 bg-amber-50" : "border-slate-300 bg-white"
                }`}
              />
              {issue && <span className="mt-0.5 block text-xs text-amber-800">{issue}</span>}
            </label>
          );
        })}

        {[0, 1].map((index) => (
          <label key={`phone-${index}`} className="block text-sm">
            <span className="font-medium">{slotLabel("連絡先", index)}</span>
            <input
              value={fields.contacts[index]?.phone ?? ""}
              placeholder="090-0000-1234"
              onChange={(e) => {
                const contacts = [...fields.contacts];
                const parsed = parsePhoneCell(e.target.value);
                if (parsed) contacts[index] = { ...parsed, relation: contacts[index]?.relation ?? parsed.relation };
                else contacts.splice(index, 1);
                onChange({ contacts: contacts.filter(Boolean) });
              }}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
            {fields.contacts[index]?.relation && (
              <span className="mt-0.5 block text-xs text-slate-500">
                続柄: {fields.contacts[index].relation}
              </span>
            )}
          </label>
        ))}

        {/* ★空欄を詰めて持つ (① を消すと ② が繰り上がる)。① が空のうちは ② を使えなくして、
            ② に打った文字が ① へ飛ばないようにする */}
        {[0, 1].map((index) => (
          <EmailInput
            key={`email-${index}`}
            label={slotLabel("メールアドレス", index)}
            value={fields.emails[index] ?? ""}
            disabled={index === 1 && !fields.emails[0]}
            // 取り込みで不正だったアドレスは取り込み値に入っていないので、① の下に出す
            issue={index === 0 ? issueOf("emails") : undefined}
            onChange={(value) => {
              const emails = [...fields.emails];
              emails[index] = value.trim();
              onChange({ emails: emails.filter(Boolean) });
            }}
          />
        ))}
      </div>

      {issues.some((i) => i.field === null) && (
        <p className="mt-2 text-xs text-amber-800">
          {issues.filter((i) => i.field === null).map((i) => i.message).join(" / ")}
        </p>
      )}
    </section>
  );
}
