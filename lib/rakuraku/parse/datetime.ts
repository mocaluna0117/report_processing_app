/**
 * 画面の日付文字列を揃える。
 *
 * ★出力は「元の精度をそのまま残す」。時刻が画面に無ければ日付だけを返し、
 *   秒まであれば秒まで返す。画面はこの文字列をそのまま出すだけなので、
 *   **無い精度を勝手に作らない・取れた精度を捨てない**を方針にする
 *   （申請日は秒まで欲しいという要望があるので、捨てるのは特に困る）。
 *
 * 移植元: tenmatsu.py 2846-2935
 * このファイルはブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */

import { toAscii } from "./text";

const DATE_RE = /(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?/;
const TIME_RE = /(\d{1,2})\s*[:時]\s*(\d{1,2})(?:\s*[:分]\s*(\d{1,2}))?/;

/** その年月日が実在するか（2026/02/30 のような値を弾く） */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

/**
 * `YYYY/MM/DD[ HH:MM[:SS]]` に揃える。読めなければ null。
 *
 * 日付として成立しない値（9999/99/99・2026/02/30 など）は null にする。
 * **時刻だけが壊れている値（25:00）は時刻を捨てて日付を返す**（日付は使えるため）。
 */
export function normalizeDatetimeText(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = toAscii(String(text)).replace(/\u3000/g, " ").trim();
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isRealDate(year, month, day)) return null; // 推測で直さず捨てる

  const pad = (n: number) => String(n).padStart(2, "0");
  let out = `${String(year).padStart(4, "0")}/${pad(month)}/${pad(day)}`;

  // 時刻は日付より後ろだけを探す（前にある別の数字を時刻と誤読しないため）
  const t = TIME_RE.exec(s.slice(m.index + m[0].length));
  if (t) {
    const hour = Number(t[1]);
    const minute = Number(t[2]);
    const second = t[3] === undefined ? 0 : Number(t[3]);
    if (hour <= 23 && minute <= 59 && second <= 59) {
      out += ` ${pad(hour)}:${pad(minute)}`;
      if (t[3] !== undefined) out += `:${pad(second)}`;
    }
  }
  return out;
}

/**
 * 比べられる形にする（数字だけ並べて0埋め）。
 * 時刻が無い値は 00:00:00 とみなすので、同じ日なら時刻がある方が後になる。
 */
export function datetimeSortKey(value: string | null | undefined): string {
  if (!value) return "";
  return String(value).replace(/\D/g, "").padEnd(14, "0").slice(0, 14);
}

/** 日付文字列に時刻が入っているか。申請日を埋め直すかの判定に使う */
export function hasTimePart(value: string | null | undefined): boolean {
  return Boolean(value) && /\d{1,2}:\d{2}/.test(String(value));
}

/**
 * 日付らしい文字列の中から、いちばん新しいものを1つ選ぶ。
 *
 * `excludeWords` を含む文字列は候補から外す（「差戻し」の日を最終承認日にしないため）。
 * ※1つの文字列に日付が2つあると最初の日付を採るので、列が特定できるなら列を指定して呼ぶ方が確実。
 */
export function pickLatestDate(
  candidates: readonly (string | null | undefined)[] | null | undefined,
  excludeWords: readonly string[] = [],
): string | null {
  const exclude = excludeWords.filter(Boolean);
  let best: string | null = null;
  for (const raw of candidates ?? []) {
    const text = raw ?? "";
    if (exclude.some((w) => text.includes(w))) continue;
    const value = normalizeDatetimeText(text);
    if (value && (best === null || datetimeSortKey(value) > datetimeSortKey(best))) {
      best = value;
    }
  }
  return best;
}
