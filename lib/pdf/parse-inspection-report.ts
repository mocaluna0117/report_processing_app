import type { Confidence, Contact, TextToken } from "@/lib/types";

/**
 * 点検報告書 (合成PDF) のテキスト層から連絡先を抜き出す。
 * 電話番号はブラウザ内でのみ保持し、/api へは送らない (メール文の組み立てにだけ使う)。
 *
 * 実データ (見本5件・全件同一座標) の下部ブロック:
 *   y≈738.9: 電話番号① (x≈142) と続柄 ご主人/奥様/その他 (x≈249〜254)
 *   y≈759.1: 「済」「済」(x≈508、点検員確認欄)  ← 電話番号② の欄はこの行に来る
 *   y≈778.6: 連絡可能時間帯 (9時 / 18時)
 */

/** 区切りに使われうるハイフン類 (mapTextItems は英数字しか半角化しないので全角も来る) */
const HYPHENS = "-‐‑−－ー";
const HYPHEN_RE = new RegExp(`[${HYPHENS}]`, "g");

/**
 * 電話番号らしいトークン。ハイフン付き (区切りは全角類も許容) または先頭0の10〜11桁。
 * 先頭0を必須にして契約番号 (例: 2101230101) を拾わないようにする。
 */
export const PHONE_TOKEN = new RegExp(
  `^(?:0\\d{1,4}[${HYPHENS}]\\d{1,4}[${HYPHENS}]\\d{3,4}|0\\d{9,10})$`,
);

/** 電話番号の断片 (数字とハイフン類だけ)。複数トークンに割れた番号の連結と、続柄候補からの除外に使う */
const PHONE_FRAGMENT = new RegExp(`^[\\d${HYPHENS}]+$`);

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

/** 同じ行とみなす y のずれ (実データの行間は約20pt) */
const ROW_TOLERANCE_PT = 6;
/** 続柄はこの範囲 (電話の右側・近傍) だけから拾う。x≈508 の「済」を続柄と誤認しないため */
const RELATION_MAX_X = 400;
const RELATION_MAX_DX = 200;
/** 複数トークンに割れた電話番号を連結して探すときの対象範囲 */
const PHONE_COLUMN_MAX_X = 250;

/**
 * 1ページ目のトークンから連絡先 (電話番号と続柄) を y 昇順で返す。
 * 電話番号① → ② の順になる。該当が無ければ空配列。
 */
export function parseInspectionContacts(tokens: TextToken[]): Contact[] {
  const page1 = tokens.filter((t) => t.page === 1);

  let phones = page1.filter((t) => isPhoneToken(t.str));

  // フォールバック: 番号が複数トークンに割れている場合、同じ行の左側トークンを連結して判定する
  if (phones.length === 0) {
    const rows = new Map<number, TextToken[]>();
    for (const t of page1) {
      if (t.x >= PHONE_COLUMN_MAX_X || !PHONE_FRAGMENT.test(t.str)) continue;
      const key = Math.round(t.y / ROW_TOLERANCE_PT);
      rows.set(key, [...(rows.get(key) ?? []), t]);
    }
    for (const row of rows.values()) {
      const sorted = row.sort((a, b) => a.x - b.x);
      const joined = sorted.map((t) => t.str).join("");
      if (isPhoneToken(joined)) {
        phones.push({ str: joined, x: sorted[0].x, y: sorted[0].y, page: 1 });
      }
    }
  }

  phones = phones.sort((a, b) => a.y - b.y);

  return phones.map((p) => {
    const relation =
      page1
        .filter(
          (t) =>
            t !== p &&
            Math.abs(t.y - p.y) <= ROW_TOLERANCE_PT &&
            t.x > p.x &&
            t.x < Math.min(RELATION_MAX_X, p.x + RELATION_MAX_DX) &&
            !PHONE_FRAGMENT.test(t.str),
        )
        .sort((a, b) => a.x - b.x)[0]?.str ?? "";
    const { phone, confidence } = formatPhone(p.str);
    return { phone, relation, confidence };
  });
}
