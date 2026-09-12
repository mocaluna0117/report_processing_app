/**
 * 伝票の値から項目を取り出す（物件名・監督・営業・PJコード・伝票No.）。
 *
 * ★どれも**推測で埋めない**。取り出せなければ null を返す。
 *   近い値や、ありそうな値を代わりに返すと、画面に出た値を信じて誤った作業をさせてしまう。
 * ★記録には生の値（「どこで」「内容」「備考」）を残し、取り出しは**読むとき**に行う。
 *   規則を直しても楽楽精算を開き直さずに済むため（移植元 tenmatsu.py:3814-3815）。
 *
 * 移植元: tenmatsu.py 2643-2759, 2842-2848
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */
import { escapeRegExp, toAscii } from "./text";

/**
 * 「どこで」から物件名を取り出す。
 *
 * 実測は `注文受注物件：〇〇 施主名：△△` / `法人受注物件：〇〇` の形で、
 * `受注物件：` の後ろから次の `〇〇：` の手前までが物件名。
 *
 * ※次の項目の手前で切るのは「**空白＋短いラベル＋コロン**」が続くときだけ。
 *   空白が無い場合は切る位置を決められないので、切らずにそのまま返す。
 */
export function parsePropertyName(where: string | null | undefined): string | null {
  if (!where) return null;
  const m = /受注物件[:：]\s*(.*)/.exec(where);
  if (!m) return null;
  let rest = m[1];
  const cut = /[\s\u3000]+[^\s\u3000:：]{1,12}[:：]/.exec(rest);
  if (cut) rest = rest.slice(0, cut.index);
  return rest.trim() || null;
}

/** 「監督：〇〇/営業：〇〇」。ラベルの後ろから、次の区切り（/・改行）までを採る */
const STAFF_RE = {
  supervisor: /監督\s*[:：]\s*([^/／\n\r]*)/,
  sales_rep: /営業\s*[:：]\s*([^/／\n\r]*)/,
} as const;

/** 値の後ろに別のラベルが続く書き方に備えて、そこで切る */
const STAFF_TAIL_RE = /[\s\u3000]*[^\s\u3000:：]{1,12}[:：].*$/;

/**
 * 「姓　名」を「姓 名」（半角スペース1つ）に揃える。読めなければ null。
 *
 * ★空白の入れ方だけを揃える。**氏名そのものは書き換えない**。
 */
export function normalizePersonName(text: string | null | undefined): string | null {
  if (!text) return null;
  const value = String(text).replace(/\u3000/g, " ").trim().replace(/\s+/g, " ");
  return value || null;
}

export interface StaffNames {
  supervisor: string | null;
  sales_rep: string | null;
}

/**
 * 「どこで」から監督・営業を取り出す。取れなければその項目は null。
 *
 * ★**「監督：〇〇/営業：〇〇」の形でないものは入力ミスとして無視する**（利用者の指定）。
 *   「監督：」が無い・値が空は、どちらも null にして推測で埋めない。
 */
export function parseStaffNames(where: string | null | undefined): StaffNames {
  const out: StaffNames = { supervisor: null, sales_rep: null };
  if (!where) return out;
  for (const key of ["supervisor", "sales_rep"] as const) {
    const m = STAFF_RE[key].exec(String(where));
    if (!m) continue;
    out[key] = normalizePersonName(m[1].replace(STAFF_TAIL_RE, ""));
  }
  return out;
}

/**
 * 値の後ろに別のラベルが続く書き方に備えて切る位置。
 * ★監督・営業の方と違い**空白を必須**にする。空白の無い値を途中で切らないため。
 */
const LABELED_TAIL_RE = /[\s\u3000]+[^\s\u3000:：/／]{1,12}[:：].*$/;

/**
 * 「〇〇：値」の形から値を取り出す。無ければ null。
 *
 * 専決決裁書の「内容」、捺印決裁書の「備考」から物件名を取り出すのに使う
 * （「物件名：架空台1丁目A号棟　工事内容：…」→「架空台1丁目A号棟」）。
 * 値は「/」か改行、または次のラベルで終わる。
 * ★ラベルの前は文頭か区切り（空白・/・、。）に限る。「旧物件名」の一部に当たらないように。
 */
export function parseLabeledField(text: string | null | undefined, label: string): string | null {
  if (!text || !label) return null;
  const re = new RegExp(`(?:^|[\\s\\u3000/／、。])${escapeRegExp(label)}[\\s\\u3000]*[:：](.*)`, "s");
  const m = re.exec(String(text));
  if (!m) return null;
  const rest = m[1].split(/[/／\r\n]/, 1)[0].replace(LABELED_TAIL_RE, "");
  return rest.trim() || null;
}

/**
 * PJコード（10桁の数字）として読めるか。読めなければ null。
 * 全角・空白・各種ハイフンは吸収する。位置で探しても10桁の検査があるので危なくない。
 */
export function parsePj(text: string | null | undefined): string | null {
  if (!text) return null;
  const digits = toAscii(String(text)).replace(/[\s\u3000\-\u2010\u2011\u2212\u30fc]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

/**
 * 伝票No.を数字だけにして先頭の0を落とす（`00002267` と `2267` を同じと見なす）。
 * 数字が1つも無ければ null。
 *
 * ※移植元は Python の `\D` を使っており、全角数字を数字として残していた。
 *   ここでは**先に半角へ寄せてから**数字を拾う。全角で書かれた番号も同じ番号として扱うため。
 */
export function normalizeDenpyoDigits(text: string | null | undefined): string | null {
  const digits = toAscii(String(text ?? "")).replace(/\D/g, "");
  return digits.replace(/^0+/, "") || null;
}
