// 電話番号の表記そろえ (点検報告書のテキスト層・顧客データの取り込みで共用)。
// 電話番号はブラウザ内でのみ扱い、/api へは送らない。
import type { Confidence } from "@/lib/types";

/**
 * 区切りに使われうるハイフン類 (全角・長音記号も来る)。
 * 文字クラスの途中に埋め込んでも範囲指定にならないよう、先頭のハイフンはエスケープ済み。
 */
export const HYPHENS = "\\-‐‑−－ー";
const HYPHEN_RE = new RegExp(`[${HYPHENS}]`, "g");

/**
 * 電話番号らしい文字列。ハイフン付き (区切りは全角類も許容) または先頭0の10〜11桁。
 * 先頭0を必須にして契約番号 (例: 2101230101) を拾わないようにする。
 */
export const PHONE_TOKEN = new RegExp(
  `^(?:0\\d{1,4}[${HYPHENS}]\\d{1,4}[${HYPHENS}]\\d{3,4}|0\\d{9,10})$`,
);

export function isPhoneToken(s: string): boolean {
  if (!PHONE_TOKEN.test(s)) return false;
  const digits = s.replace(/\D/g, "").length;
  return digits === 10 || digits === 11;
}

/**
 * 電話番号の表記を「ハイフン付き・半角」に揃える。
 * ハイフン無しの数字列は桁数から区切りを推定するが、市外局番の規則は網羅できない
 * (04・0123系など) ため confidence を warn にして確認を促す。
 */
export function formatPhone(raw: string): { phone: string; confidence: Confidence } {
  const trimmed = raw.trim();
  if (HYPHEN_RE.test(trimmed)) {
    HYPHEN_RE.lastIndex = 0;
    return { phone: trimmed.replace(HYPHEN_RE, "-"), confidence: "ok" };
  }
  const d = trimmed.replace(/\D/g, "");
  if (d.length === 11) {
    return { phone: `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`, confidence: "warn" };
  }
  if (d.length === 10) {
    if (/^(0120|0800)/.test(d)) {
      return { phone: `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`, confidence: "warn" };
    }
    if (/^0[36]/.test(d)) {
      return { phone: `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`, confidence: "warn" };
    }
    return { phone: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`, confidence: "warn" };
  }
  return { phone: trimmed, confidence: "warn" };
}
