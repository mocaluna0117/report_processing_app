// 助っ人クラウド (旧システム) の顧客情報1行 → Customer。
// このファイル形式で新しいデータが来ることは無く、取り込みは一度きりの想定。
import { fnv1a64 } from "@/lib/after/hash";
import { developerFromBranch } from "@/lib/after/developer";
import {
  buildSearchKey,
  cleanPropertyName,
  isCorporateName,
  joinSeiMei,
  normalizeHandoverDate,
  normalizeOwnerKana,
  normalizeOwnerName,
  parsePhoneCell,
  pickPostalCode,
} from "@/lib/after/normalize";
import { managementIdToPj } from "@/lib/after/pj";
import type { Customer, CustomerFields, CustomerIssue } from "@/lib/after/types";
import { trimWide } from "@/lib/text";
import type { Contact } from "@/lib/types";

/** 正規化後のヘッダー名 (lib/after/table.ts の normalizeHeader を通した形) */
export const SUKETTO_HEADERS = {
  sei: "施主名(姓)",
  mei: "施主名(名)",
  seiKana: "施主名かな(姓)",
  meiKana: "施主名かな(名)",
  tel: "建築地電話番号",
  mobile: "建築地携帯電話番号",
  property: "住宅名(物件名)(区画番号)など",
  prefecture: "建築地都道府県",
  city: "建築地市区町村番地",
  postal: "建築地郵便番号",
  postalHome: "現住所郵便番号",
  managementId: "管理ID",
  handover: "引渡日",
  branch: "担当支店",
} as const;

export type RowResult =
  | { ok: true; customer: Customer }
  | { ok: false; skipReason: string };

export function suketToCustomer(
  record: Record<string, string>,
  sourceRow: number,
  now: number,
): RowResult {
  const get = (key: string) => record[key] ?? "";
  const managementId = trimWide(get(SUKETTO_HEADERS.managementId));
  // 管理IDが「DX」の行 (点検保守台帳へ移した印) もそのまま取り込む。
  // 台帳にも載っていれば lib/after/dedup.ts が消すので、ここで落とすと
  // 台帳側が「×使用禁止×」だった顧客がどちらからも消えてしまう
  const conversion = managementIdToPj(managementId);

  const issues: CustomerIssue[] = [];
  if (conversion.issue) issues.push({ field: "pj", message: conversion.issue });

  const ownerRaw = joinSeiMei(get(SUKETTO_HEADERS.sei), get(SUKETTO_HEADERS.mei));
  const owner = normalizeOwnerName(ownerRaw);
  if (owner.issue) issues.push({ field: "ownerName", message: owner.issue });

  const kanaRaw = joinSeiMei(get(SUKETTO_HEADERS.seiKana), get(SUKETTO_HEADERS.meiKana));
  const kana = normalizeOwnerKana(kanaRaw, owner.corporate);
  if (kana.issue) issues.push({ field: "ownerKana", message: kana.issue });

  // 連絡先は「携帯 → 固定」の順 (メール文の連絡先①②もこの順になる)
  const contacts: Contact[] = [];
  for (const key of [SUKETTO_HEADERS.mobile, SUKETTO_HEADERS.tel]) {
    const contact = parsePhoneCell(get(key));
    if (contact) contacts.push(contact);
  }

  const handover = normalizeHandoverDate(get(SUKETTO_HEADERS.handover));
  if (handover.unreadable) {
    issues.push({
      field: "handoverDate",
      message: `引渡日を日付として読めませんでした (${handover.unreadable})`,
    });
  }

  const developer = developerFromBranch(get(SUKETTO_HEADERS.branch));
  if (!developer) issues.push({ field: "developer", message: "担当支店が空のため事業者が未設定です" });

  const address = `${trimWide(get(SUKETTO_HEADERS.prefecture))}${trimWide(get(SUKETTO_HEADERS.city))}`;
  // 住所は建築地なので郵便番号も建築地を優先し、空欄なら現住所で埋める
  const postal = pickPostalCode(
    get(SUKETTO_HEADERS.postal),
    get(SUKETTO_HEADERS.postalHome),
  );
  if (postal.issue) issues.push({ field: "postalCode", message: postal.issue });

  const imported: CustomerFields = {
    pj: conversion.pj,
    developer,
    propertyName: cleanPropertyName(get(SUKETTO_HEADERS.property)),
    ownerName: owner.name,
    ownerKana: kana.kana,
    postalCode: postal.postalCode,
    address,
    contacts,
    emails: [],
    handoverDate: handover.date,
    supervisor: "",
    salesRep: "",
    memo: "",
  };

  // 管理IDは重複するので、取り込んだ内容そのものをIDにする
  // (完全に同じ行は同じIDになり1件にまとまる。再取込でも同じIDなので編集が残る)
  // ★ここに項目を足してはいけない。足すと同じ行でもIDが変わり、助っ人の取り込みは
  //   全置換なので前のIDのレコードが消える = 利用者の手直し(edits)が全部失われる。
  //   郵便番号を足しても列の有無でIDが変わらないのはこのため
  //   (tests/after-import.test.ts で固定してある)。
  const fingerprint = [
    managementId,
    imported.pj ?? "",
    imported.ownerName,
    imported.ownerKana,
    imported.propertyName,
    imported.address,
    imported.handoverDate ?? "",
    imported.developer ?? "",
    ...imported.contacts.map((c) => `${c.phone}|${c.relation}`),
  ].join("");

  return {
    ok: true,
    customer: {
      id: `sk:${fnv1a64(fingerprint)}`,
      source: "suketto",
      sourceKey: managementId,
      sourceRow,
      imported,
      edits: {},
      issues,
      corporate: owner.corporate || isCorporateName(imported.propertyName),
      searchKey: buildSearchKey(imported),
      importedAt: now,
      editedAt: null,
    },
  };
}
