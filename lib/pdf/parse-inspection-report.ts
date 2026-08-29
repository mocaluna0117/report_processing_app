import { HYPHENS, isPhoneToken as isPhone } from "@/lib/phone";
import type { Contact, TextToken } from "@/lib/types";

/**
 * 点検報告書 (合成PDF) のテキスト層から連絡先を抜き出す。
 * 電話番号はブラウザ内でのみ保持し、/api へは送らない (メール文の組み立てにだけ使う)。
 *
 * 実データ (見本5件・全件同一座標) の下部ブロック:
 *   y≈738.9: 電話番号① (x≈142) と続柄 ご主人/奥様/その他 (x≈249〜254)
 *   y≈759.1: 「済」「済」(x≈508、点検員確認欄)  ← 電話番号② の欄はこの行に来る
 *   y≈778.6: 連絡可能時間帯 (9時 / 18時)
 */

/** 電話番号の判定・整形は顧客データの取り込みと共通 (lib/phone.ts) */
export { formatPhone, isPhoneToken, PHONE_TOKEN } from "@/lib/phone";
import { formatPhone as formatPhoneValue } from "@/lib/phone";

/** 電話番号の断片 (数字とハイフン類だけ)。複数トークンに割れた番号の連結と、続柄候補からの除外に使う */
const PHONE_FRAGMENT = new RegExp(`^[\\d${HYPHENS}]+$`);

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

  let phones = page1.filter((t) => isPhone(t.str));

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
      if (isPhone(joined)) {
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
    const { phone, confidence } = formatPhoneValue(p.str);
    return { phone, relation, confidence };
  });
}
