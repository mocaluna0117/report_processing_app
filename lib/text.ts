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
