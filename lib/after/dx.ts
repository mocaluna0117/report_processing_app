// 点検保守台帳 (DX) の顧客情報1行 → Customer。今後の顧客データはこの形式で追加される。
import { resolveAfterDeveloper } from "@/lib/after/developer";
import {
  buildSearchKey,
  cleanPropertyName,
  isCorporateName,
  isEmail,
  normalizeOwnerKana,
  normalizeOwnerName,
  parsePhoneCell,
} from "@/lib/after/normalize";
import { parseBukkenNumber } from "@/lib/after/pj";
import type { RowResult } from "@/lib/after/suketto";
import type { Customer, CustomerFields, CustomerIssue } from "@/lib/after/types";
import { trimWide } from "@/lib/text";
import type { Contact } from "@/lib/types";

/** 正規化後のヘッダー名 (lib/after/table.ts の normalizeHeader を通した形) */
export const DX_HEADERS = {
  ledger: "台帳種類",
  bukken: "物件番号",
  property: "物件名",
  owner: "居住者名",
  kana: "居住者名カナ",
  address: "所在地住居表示",
  building: "所在地住居表示-建物名",
  tel1: "居住者連絡先1-TEL1",
  tel2: "居住者連絡先1-TEL2",
  email1: "居住者連絡先1-email1",
  email2: "居住者連絡先1-email2",
  sales: "営業担当担当者(主)",
  memo: "備考",
} as const;

/** 台帳の書き出しに混ざる技術行 (列キーが値として入っている行) */
const TECHNICAL_LEDGER = /^importMaster$/i;
/** 助っ人クラウド側に既にある物件 (重複登録しない) */
const DO_NOT_USE = /×使用禁止×/;

export function dxRowToCustomer(
  record: Record<string, string>,
  sourceRow: number,
  now: number,
): RowResult {
  const get = (key: string) => record[key] ?? "";
  if (TECHNICAL_LEDGER.test(trimWide(get(DX_HEADERS.ledger)))) {
    return { ok: false, skipReason: "技術行 (見出しのキー)" };
  }
  const propertyRaw = get(DX_HEADERS.property);
  if (DO_NOT_USE.test(propertyRaw)) {
    return { ok: false, skipReason: "物件名が×使用禁止× (助っ人クラウド側にある物件)" };
  }
  const bukken = parseBukkenNumber(get(DX_HEADERS.bukken));
  if (!bukken.pj) return { ok: false, skipReason: bukken.skipReason ?? "物件番号を読めません" };

  const issues: CustomerIssue[] = [];
  const propertyName = cleanPropertyName(propertyRaw);
  const { developer, issue: developerIssue } = resolveAfterDeveloper(bukken.pj, propertyName);
  if (developerIssue) issues.push({ field: "developer", message: developerIssue });

  const owner = normalizeOwnerName(get(DX_HEADERS.owner));
  if (owner.issue) issues.push({ field: "ownerName", message: owner.issue });
  const kana = normalizeOwnerKana(get(DX_HEADERS.kana), owner.corporate);
  if (kana.issue) issues.push({ field: "ownerKana", message: kana.issue });

  // 連絡先は TEL1 → TEL2 の順 (メール文の連絡先①②もこの順になる)
  const contacts: Contact[] = [];
  for (const key of [DX_HEADERS.tel1, DX_HEADERS.tel2]) {
    const contact = parsePhoneCell(get(key));
    if (contact) contacts.push(contact);
  }

  const emails: string[] = [];
  for (const key of [DX_HEADERS.email1, DX_HEADERS.email2]) {
    const value = trimWide(get(key));
    if (!value) continue;
    if (isEmail(value)) emails.push(value);
    else issues.push({ field: "emails", message: `メールアドレスの形式が不正です (${value})` });
  }

  // 住所は住居表示に建物名 (マンション名・部屋番号) を続ける
  const addressParts = [trimWide(get(DX_HEADERS.address)), trimWide(get(DX_HEADERS.building))];
  const address = addressParts.filter(Boolean).join("　");
  if (!address) issues.push({ field: "address", message: "所在地住居表示が空です" });

  const imported: CustomerFields = {
    pj: bukken.pj,
    developer,
    propertyName,
    ownerName: owner.name,
    ownerKana: kana.kana,
    address,
    contacts,
    emails,
    // 点検保守台帳には引渡日の列が無い
    handoverDate: null,
    salesRep: trimWide(get(DX_HEADERS.sales)),
    memo: trimWide(get(DX_HEADERS.memo)),
  };

  return {
    ok: true,
    customer: {
      // 物件番号は一意なのでそのままIDにする (再取込は同じIDに上書き = 編集が残る)
      id: `dx:${bukken.pj}`,
      source: "dx",
      sourceKey: trimWide(get(DX_HEADERS.bukken)),
      sourceRow,
      imported,
      edits: {},
      issues,
      corporate: owner.corporate || isCorporateName(propertyName),
      searchKey: buildSearchKey(imported),
      importedAt: now,
      editedAt: null,
    },
  };
}
