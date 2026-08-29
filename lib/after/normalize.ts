// 顧客データの各項目を整える純関数。取り込み時に1回だけ通す。
import { hiraganaToKatakana, normalizeKana } from "@/lib/kana";
import { HYPHENS, formatPhone } from "@/lib/phone";
import {
  toDateZeroPad,
  toFullWidthKatakana,
  toFullWidthSpace,
  toHalfWidthAlnum,
  trimWide,
} from "@/lib/text";
import type { CustomerFields } from "@/lib/after/types";
import type { Contact } from "@/lib/types";

/** 物件名から落とす装飾 (取り込み元の表記ゆれを吸収する) */
const PROPERTY_NOISE: readonly RegExp[] = [
  /[（(]\s*仮称\s*[)）]/g,
  /新築工事/g,
  /分譲住宅/g,
  /[（(]\s*全\s*\d+\s*(?:区画|棟)\s*[)）]/g,
  /[（(]\s*\d+\s*(?:区画|棟)\s*[)）]/g,
  /[（(]\s*BS\s*[)）]/gi,
  // 「（第2期4区画）」のように括弧ごと付くことも、括弧無しのこともある
  /[（(]?\s*第\s*\d+\s*期\s*\d+\s*区画\s*[)）]?/g,
];

/** 「（仮称）セキュレア架空町1丁目 3号地（全6区画）　新築工事」→「セキュレア架空町1丁目 3号地」 */
export function cleanPropertyName(raw: string): string {
  let value = toHalfWidthAlnum(toFullWidthKatakana(raw));
  for (const pattern of PROPERTY_NOISE) value = value.replace(pattern, " ");
  return value
    .replace(/[\s　]+/g, " ")
    .replace(/^[\s　・-]+|[\s　・-]+$/g, "")
    .trim();
}

const CORPORATE =
  /(株式会社|有限会社|合同会社|合資会社|一般社団法人|㈱|㈲|[（(]\s*株\s*[)）]|[（(]\s*有\s*[)）]|法人|組合|事務所|商店|建設|工務店|不動産|管理|ビル)/;

export function isCorporateName(s: string): boolean {
  return CORPORATE.test(s);
}

export interface NameResult {
  name: string;
  corporate: boolean;
  issue?: string;
}

/**
 * 氏名を整える。個人は姓名の間を全角スペースにし、法人名はそのまま (社名の空白を変えない)。
 * 区切りが無い個人名は分割せず、要確認にして画面で直してもらう。
 */
export function normalizeOwnerName(raw: string): NameResult {
  const value = trimWide(raw);
  if (!value) return { name: "", corporate: false, issue: "氏名が空です" };
  if (isCorporateName(value)) return { name: value, corporate: true };
  const name = toFullWidthSpace(value).replace(/　+/g, "　");
  if (!name.includes("　") && [...name].length >= 4) {
    return { name, corporate: false, issue: "姓名の区切りが無いため要確認です" };
  }
  return { name, corporate: false };
}

/** 助っ人クラウドは姓と名が別セル (姓の末尾に全角スペースが入っていることが多い) */
export function joinSeiMei(sei: string, mei: string): string {
  const s = trimWide(sei);
  const m = trimWide(mei);
  if (s && m) return `${s}　${m}`;
  return s || m;
}

export interface KanaResult {
  kana: string;
  issue?: string;
}

/** カナ読み: 半角カナ・ひらがなをカタカナに寄せ、姓名間は全角スペース1つにする */
export function normalizeOwnerKana(raw: string, corporate = false): KanaResult {
  const value = trimWide(raw);
  if (!value) return { kana: "" };
  const { kana, valid } = normalizeKana(hiraganaToKatakana(toFullWidthKatakana(value)));
  if (!valid && !corporate) {
    return { kana, issue: "カナにカタカナ以外が含まれます (要確認)" };
  }
  return { kana };
}

const RELATION_ALIASES: readonly [RegExp, string][] = [
  [/^(?:御主人|ご主人|主人|夫)$/, "ご主人"],
  [/^(?:奥様|奥さま|奥さん|妻)$/, "奥様"],
];

function normalizeRelation(raw: string): string {
  const value = trimWide(raw);
  for (const [pattern, label] of RELATION_ALIASES) {
    if (pattern.test(value)) return label;
  }
  return value;
}

const PHONE_BODY = new RegExp(`^([\\d${HYPHENS}\\s]+?)\\s*([^\\d${HYPHENS}\\s].*)$`);

/**
 * 電話番号のセルを番号と続柄に分ける。
 * 助っ人クラウドには「090-0000-0000（奥様）」のように続柄が付いた値がある。
 */
export function parsePhoneCell(raw: string): Contact | null {
  const value = toHalfWidthAlnum(trimWide(raw));
  if (!value) return null;
  const withParen = /^(.*?)[（(]([^)）]*)[)）]\s*$/.exec(value);
  const body = trimWide(withParen ? withParen[1] : value);
  let relation = withParen ? normalizeRelation(withParen[2]) : "";
  // 括弧なしで続柄が続く場合 (「090-0000-0000 奥様」)
  const split = PHONE_BODY.exec(body);
  const numberPart = split ? split[1] : body;
  if (!relation && split) relation = normalizeRelation(split[2]);
  const digits = numberPart.replace(/\D/g, "");
  if (!digits) return null;
  const { phone, confidence } = formatPhone(numberPart.replace(/\s+/g, ""));
  // 桁数が電話番号として不自然なものは要確認にする
  const plausible = digits.length === 10 || digits.length === 11;
  return { phone, relation, confidence: plausible ? confidence : "warn" };
}

export interface HandoverResult {
  date: string | null;
  issue?: string;
}

/** 引渡日は yyyy/mm/dd (ゼロ埋め) に揃える */
export function normalizeHandoverDate(raw: string): HandoverResult {
  const value = toHalfWidthAlnum(trimWide(raw))
    .replace(/[.年月-]/g, "/")
    .replace(/日$/, "");
  if (!value) return { date: null };
  if (!/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(value)) {
    return { date: null, issue: `引渡日の形式が読めません (${trimWide(raw)})` };
  }
  return { date: toDateZeroPad(value) };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(s: string): boolean {
  return EMAIL.test(trimWide(s));
}

const SEARCH_NOISE = new RegExp(`[\\s　${HYPHENS}()（）・.,、。]`, "g");

/** 検索用の正規化: ひらがな/カタカナ・半角/全角・ハイフン有無の違いを吸収する */
export function normalizeSearchText(s: string): string {
  return hiraganaToKatakana(s.normalize("NFKC")).toLowerCase().replace(SEARCH_NOISE, "");
}

/** 検索キー (氏名・カナ・PJ・物件名・住所・電話・メールをまとめて正規化) */
export function buildSearchKey(fields: CustomerFields): string {
  const parts = [
    fields.pj ?? "",
    fields.ownerName,
    fields.ownerKana,
    fields.propertyName,
    fields.address,
    ...fields.contacts.map((c) => c.phone),
    ...fields.emails,
  ];
  return normalizeSearchText(parts.join(" "));
}

/** 検索語をAND条件の配列にする */
export function normalizeQuery(query: string): string[] {
  return query
    .split(/[\s　]+/)
    .map((term) => normalizeSearchText(term))
    .filter(Boolean);
}
