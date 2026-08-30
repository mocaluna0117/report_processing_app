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

/**
 * 連名の区切り。「サトウ　ハナコ・サトウ　ジロウ」と「・」で並べるほか、
 * 「サワダ　イサム（タチバナ　ミキコ）」のように2人目を括弧で添える書き方もある。
 * どちらもカナとしては正しい書き方なので、要確認にはしない。
 * (分割した区切りも残すため丸ごと捕捉する)
 */
const JOINT_SEPARATOR = /([・､、（）()])/;

/** 区切りの表記を揃える (読点・半角中黒は「・」に、括弧は全角に) */
const SEPARATOR_FORMS = new Map([
  ["・", "・"],
  ["､", "・"],
  ["、", "・"],
  ["（", "（"],
  ["(", "（"],
  ["）", "）"],
  [")", "）"],
]);

/** カナ読み: 半角カナ・ひらがなをカタカナに寄せ、姓名間は全角スペース1つにする */
export function normalizeOwnerKana(raw: string, corporate = false): KanaResult {
  const value = trimWide(raw);
  if (!value) return { kana: "" };
  // 連名は1人ずつ整えてからつなぎ直す (区切りは書かれていた形のまま残す)
  const names: { kana: string; valid: boolean }[] = [];
  let kana = "";
  for (const piece of hiraganaToKatakana(toFullWidthKatakana(value)).split(JOINT_SEPARATOR)) {
    const separator = SEPARATOR_FORMS.get(piece);
    if (separator !== undefined) {
      kana += separator;
      continue;
    }
    const part = normalizeKana(piece);
    if (part.kana === "") continue;
    names.push(part);
    kana += part.kana;
  }
  // 中身が無いまま残った区切りを落とす (「サトウ　ハナコ・」「（）」)
  kana = kana
    .replace(/（[\s　]*）/g, "")
    .replace(/・+/g, "・")
    .replace(/^・+|・+$/g, "");
  if (names.length > 0 && names.every((part) => part.valid)) return { kana };
  if (corporate) return { kana };
  return { kana, issue: "カナにカタカナ以外が含まれます (要確認)" };
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
  /** 日付として読めなかった元の値 (どの列かは呼び出し側が付ける) */
  unreadable?: string;
}

/** 和暦の元号 → 元年の前年 (令和1年 = 2019年) */
const ERAS: readonly [RegExp, number][] = [
  [/^(?:令和|R)/i, 2018],
  [/^(?:平成|H)/i, 1988],
  [/^(?:昭和|S)/i, 1925],
];

/**
 * Excelの日付シリアル値が入りうる範囲 (1927年〜2064年)。
 * 日付書式のセルは数値で書き出されるため、この範囲の数値は日付として読む。
 */
const SERIAL_MIN = 10000;
const SERIAL_MAX = 60000;

function fromSerial(serial: number): { y: number; m: number; d: number } {
  // Excelの起点は1899/12/30 (1900年をうるう年とみなす不具合に合わせた慣例)。
  // 小数部は時刻なので切り捨てて日付だけを取る
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** 実在する日付か (2025/2/30 のような値を弾く) */
function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}

/**
 * 引渡日・築年月日を yyyy/mm/dd (ゼロ埋め) に揃える。
 * 取り込み元によって書き方が違うので、次を受け付ける:
 * 2025/3/10・2025-3-10・2025.3.10・2025年3月10日・20250310・全角数字・
 * 時刻付き (2025/3/10 0:00)・和暦 (令和7年3月10日)・Excelの日付シリアル値 (45726)
 */
export function normalizeHandoverDate(raw: string): HandoverResult {
  const input = toHalfWidthAlnum(trimWide(raw));
  if (!input) return { date: null };
  const unreadable: HandoverResult = {
    date: null,
    issue: `日付の形式が読めません (${trimWide(raw)})`,
    unreadable: trimWide(raw),
  };

  // 時刻が付いていることがあるので日付部分だけ見る
  const head = input.split(/[ T]/)[0];

  // Excelの日付シリアル値 (日付書式のセルは数値で書き出される。小数部は時刻)
  if (/^\d+(?:\.\d+)?$/.test(head)) {
    const n = Number(head);
    if (n >= SERIAL_MIN && n <= SERIAL_MAX) {
      const { y, m, d } = fromSerial(n);
      if (isRealDate(y, m, d)) return { date: `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}` };
    }
    // 20250310 のような8桁表記
    const digits = /^(\d{4})(\d{2})(\d{2})$/.exec(head.split(".")[0]);
    if (digits) {
      const [y, m, d] = digits.slice(1).map(Number);
      if (isRealDate(y, m, d)) return { date: `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}` };
    }
    return unreadable;
  }

  // 和暦 (令和7年3月10日 / R7/3/10)
  let body = head.replace(/[．／]/g, "/").replace(/[.-]/g, "/");
  for (const [pattern, base] of ERAS) {
    if (!pattern.test(body)) continue;
    const rest = body.replace(pattern, "");
    const m = /^(\d{1,2}|元)[/年](\d{1,2})[/月](\d{1,2})/.exec(rest);
    if (!m) return unreadable;
    body = `${base + (m[1] === "元" ? 1 : Number(m[1]))}/${m[2]}/${m[3]}`;
    break;
  }

  const parts = /^(\d{4})[/年](\d{1,2})[/月](\d{1,2})日?$/.exec(body.replace(/日$/, "日"));
  if (!parts) return unreadable;
  const [y, m, d] = parts.slice(1).map(Number);
  if (!isRealDate(y, m, d)) return unreadable;
  return { date: `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}` };
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
