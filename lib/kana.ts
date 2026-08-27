import { toFullWidthSpace } from "@/lib/text";

/** /api/name-reading の応答 */
export interface NameReadingResponse {
  /** カタカナの読み (姓と名の間は全角スペース)。取得できなければ空 */
  kana: string;
  /** 他に考えられる読み */
  alternatives: string[];
  /** high: 読みが一つに定まる一般的な名前 / low: 複数の読みがある・外国人名・形式不正 */
  confidence: "high" | "low";
  engine: "gemini" | "none";
  error?: string;
}

/** ひらがな → カタカナ */
export function hiraganaToKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/**
 * 読みの表記を「カタカナ・姓名間は全角スペース1つ」に揃える。
 * valid=false はカタカナ以外 (漢字の混入など) が残っている場合。
 */
export function normalizeKana(raw: string): { kana: string; valid: boolean } {
  const kana = toFullWidthSpace(hiraganaToKatakana(raw.trim()))
    .replace(/　+/g, "　")
    .replace(/^　|　$/g, "");
  return { kana, valid: kana.length > 0 && /^[ァ-ヶー　]+$/.test(kana) };
}

/** Geminiの生出力を整形する (ルートから呼ぶ。純関数なのでテスト可) */
export function normalizeNameReading(raw: {
  kana?: unknown;
  alternatives?: unknown;
  confidence?: unknown;
}): Pick<NameReadingResponse, "kana" | "alternatives" | "confidence"> {
  const main = typeof raw.kana === "string" ? normalizeKana(raw.kana) : { kana: "", valid: false };
  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => normalizeKana(x))
    .filter((a) => a.valid && a.kana !== main.kana)
    .map((a) => a.kana)
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .slice(0, 5);

  let confidence: "high" | "low" = raw.confidence === "high" ? "high" : "low";
  if (!main.valid || alternatives.length > 0) confidence = "low";

  return { kana: main.kana, alternatives, confidence };
}
