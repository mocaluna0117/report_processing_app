/**
 * 文字の揃え方で、複数の読み取り処理が共有するもの。
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */

/** 全角の数字と記号を半角に寄せる（画面によって混ざる）。移植元 tenmatsu.py:2860 `_WIDE_TO_ASCII` */
const WIDE_TO_ASCII: Record<string, string> = {
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  "：": ":", "／": "/", "．": ".", "－": "-",
};

export function toAscii(text: string): string {
  return text.replace(/[０-９：／．－]/g, (c) => WIDE_TO_ASCII[c] ?? c);
}

/** 正規表現の中で文字をそのまま使えるように逃がす（Python の re.escape 相当） */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
