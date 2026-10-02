// 手入力で登録するお客様 (顧客データのファイルに無いお客様)。純関数のみ。
//
// ★入力した値は「取り込み値」(imported) に入れる。登録したあとの手直し・定期点検の引渡日・
//   顛末書の監督営業は、取り込んだお客様と同じ道 (edits) を通るので、共有フォルダーの
//   突き合わせ (項目ごとの後勝ち) もそのまま効く。
import { effectiveFields } from "@/lib/after/customer";
import { resolveAfterDeveloper } from "@/lib/after/developer";
import {
  buildSearchKey,
  isCorporateName,
  isEmail,
  normalizeOwnerKana,
  normalizeOwnerName,
  parsePhoneCell,
  tidyDateInput,
  tidyPostalInput,
} from "@/lib/after/normalize";
import type { Customer, CustomerFields } from "@/lib/after/types";
import { toHalfWidthAlnum, trimWide } from "@/lib/text";
import type { Contact } from "@/lib/types";

/** 手入力のお客様の id の頭。取り込んだお客様 (dx: / sk:) と重ならない */
export const MANUAL_ID_PREFIX = "mn:";

/** 登録欄の下書き (打ったままの文字。登録するときに整える) */
export interface ManualDraft {
  pj: string;
  developer: string;
  propertyName: string;
  ownerName: string;
  ownerKana: string;
  postalCode: string;
  address: string;
  handoverDate: string;
  supervisor: string;
  salesRep: string;
  phones: [string, string];
  emails: [string, string];
}

export const emptyManualDraft = (): ManualDraft => ({
  pj: "",
  developer: "",
  propertyName: "",
  ownerName: "",
  ownerKana: "",
  postalCode: "",
  address: "",
  handoverDate: "",
  supervisor: "",
  salesRep: "",
  phones: ["", ""],
  emails: ["", ""],
});

/** 何も入れていない下書きか (「入力を消す」を出すかどうか) */
export function isEmptyDraft(draft: ManualDraft): boolean {
  return Object.values(draft).every((value) =>
    Array.isArray(value) ? value.every((v) => !trimWide(v)) : !trimWide(value),
  );
}

/** 「このお客様を登録」が押せない理由 (押せるなら null) */
export function manualBlockedReason(draft: ManualDraft): string | null {
  if (!trimWide(draft.ownerName)) return "お客様氏名を入れてください";
  const badEmail = draft.emails.map(trimWide).find((email) => email && !isEmail(email));
  if (badEmail) return `メールアドレスの形式が正しくありません (${badEmail})`;
  return null;
}

/** PJ は半角にして空白を落とす (全角や区切りの空白で打たれても同じ PJ になるように) */
function normalizePj(raw: string): string {
  return toHalfWidthAlnum(trimWide(raw)).replace(/\s+/g, "");
}

/**
 * PJ から事業者を補う (登録欄で事業者が空欄のときに使う)。
 * 判定できなければ空文字 (誤った事業者を入れるより安全)。
 */
export function developerFromPj(pj: string, propertyName: string): string {
  const code = normalizePj(pj);
  if (!code) return "";
  return resolveAfterDeveloper(code, trimWide(propertyName)).developer ?? "";
}

/**
 * 同じ PJ のお客様がもういるか (二重に登録しないよう、登録欄で知らせる)。
 * PJ は物件ごとに1つなので、一致すればほぼ同じ物件。氏名は同姓同名があるので見ない。
 */
export function findSamePj(customers: readonly Customer[], pj: string): Customer | null {
  const code = normalizePj(pj);
  if (!code) return null;
  return customers.find((c) => effectiveFields(c).pj === code) ?? null;
}

/**
 * 下書きからお客様1件を作る。
 * ★整え方は取り込みに合わせる (氏名は姓名の間を全角スペース、カナはカタカナ、郵便番号は 123-4567、
 *   引渡日は yyyy/mm/dd)。ただし読めない値は捨てずにそのまま残す — 打った本人が目の前にいるので、
 *   取り込みのように要確認へ回すより、その値のまま見せた方が直しやすい。
 */
export function createManualCustomer(draft: ManualDraft, id: string, now: number): Customer {
  const propertyName = trimWide(draft.propertyName);
  const owner = normalizeOwnerName(draft.ownerName);
  const corporate = owner.corporate || isCorporateName(propertyName);
  const kana = normalizeOwnerKana(draft.ownerKana, corporate);
  const pj = normalizePj(draft.pj);
  const handoverDate = tidyDateInput(trimWide(draft.handoverDate));

  const imported: CustomerFields = {
    pj: pj || null,
    developer: trimWide(draft.developer) || null,
    propertyName,
    ownerName: owner.name,
    // カタカナに寄せられなかったときは、打ったままを残す
    ownerKana: kana.issue ? trimWide(draft.ownerKana) : kana.kana,
    postalCode: tidyPostalInput(trimWide(draft.postalCode)),
    address: trimWide(draft.address),
    contacts: draft.phones.map(parsePhoneCell).filter((c): c is Contact => c !== null),
    emails: draft.emails.map(trimWide).filter(Boolean),
    handoverDate: handoverDate || null,
    supervisor: trimWide(draft.supervisor),
    salesRep: trimWide(draft.salesRep),
    memo: "",
  };

  return {
    id,
    source: "manual",
    // 取り込み元のファイルが無いので、元の管理IDも行番号も無い
    sourceKey: "",
    sourceRow: 0,
    imported,
    edits: {},
    issues: [],
    corporate,
    searchKey: buildSearchKey(imported),
    importedAt: now,
    editedAt: null,
  };
}
