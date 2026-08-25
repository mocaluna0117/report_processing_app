/**
 * 全角英数字 (Ａ-Ｚａ-ｚ０-９) を半角に変換する。
 * すべての出力 (Excel列・要約・結合PDF名) で英数字は半角に揃える方針。
 * 記号・カナ・漢字はそのまま (NFKCのような広範な変換は行わない)。
 */
export function toHalfWidthAlnum(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

/** 「2026/07/22」→「2026/7/22」(ゼロ埋めなし表記)。日付形式でなければそのまま返す */
export function toDateNoPad(s: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
  if (!m) return s;
  return `${Number(m[1])}/${Number(m[2])}/${Number(m[3])}`;
}
