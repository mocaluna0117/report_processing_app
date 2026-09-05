"use client";

import {
  effectiveFields,
  isReportHandover,
  isTenmatsuStaff,
  openIssues,
} from "@/lib/after/customer";
import type { Customer, CustomerFields } from "@/lib/after/types";
import { normalizePostalCode, parsePhoneCell } from "@/lib/after/normalize";

type TextField =
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
 * nullable な項目は空欄を null にする (未設定と空文字を区別するため)。
 * normalize は入力欄から離れたときだけ当てる (打っている途中に整えると入力できなくなる)。
 */
const FIELD_LABELS: {
  key: TextField;
  label: string;
  placeholder?: string;
  nullable?: boolean;
  normalize?: (value: string) => string;
}[] = [
  { key: "pj", label: "PJ", placeholder: "2101230101", nullable: true },
  { key: "developer", label: "事業者", placeholder: "大和ハウス工業", nullable: true },
  { key: "propertyName", label: "物件名称" },
  { key: "ownerName", label: "お客様氏名", placeholder: "山田　太郎" },
  { key: "ownerKana", label: "お客様氏名 (カナ)", placeholder: "ヤマダ　タロウ" },
  {
    key: "postalCode",
    label: "郵便番号",
    placeholder: "123-4567",
    // 7桁として読めたときだけ 123-4567 に整える。読めない値はそのまま残す
    normalize: (value) => normalizePostalCode(value).postalCode || value,
  },
  { key: "address", label: "住所" },
  { key: "handoverDate", label: "引渡日", placeholder: "2025/09/26", nullable: true },
  { key: "supervisor", label: "監督", placeholder: "山田 太郎" },
  { key: "salesRep", label: "営業", placeholder: "佐藤 花子" },
];

/** 選んだお客様の内容。取り込みで判断できなかった項目はここで直す (再取り込みしても残る) */
export function CustomerCard({
  customer,
  onChange,
  onReset,
}: {
  customer: Customer;
  onChange: (patch: Partial<CustomerFields>) => void;
  onReset: () => void;
}) {
  const fields = effectiveFields(customer);
  const issues = openIssues(customer);
  const issueOf = (key: keyof CustomerFields) => issues.find((i) => i.field === key)?.message;
  const edited = (key: keyof CustomerFields) => key in customer.edits;
  // 点検保守台帳が空欄だったので助っ人クラウドから補った項目
  const supplemented = (key: keyof CustomerFields) =>
    !edited(key) && key in (customer.supplements ?? {});

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">
          お客様の情報
          <span className="ml-2 text-xs font-normal text-slate-500">
            直した内容はこの端末に保存され、顧客データを取り込み直しても残ります
          </span>
        </h2>
        {Object.keys(customer.edits).length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            取り込んだ内容に戻す
          </button>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {FIELD_LABELS.map(({ key, label, placeholder, nullable, normalize }) => {
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
            <span className="font-medium">連絡先{index === 0 ? "①" : "②"}</span>
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
      </div>

      {fields.emails.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">メール: {fields.emails.join(" / ")}</p>
      )}
      {issues.some((i) => i.field === null) && (
        <p className="mt-2 text-xs text-amber-800">
          {issues.filter((i) => i.field === null).map((i) => i.message).join(" / ")}
        </p>
      )}
    </section>
  );
}
