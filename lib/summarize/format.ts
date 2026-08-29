/**
 * アフター受付内容の整形。
 * 事象が複数あると1行に並んで読みにくいため、1事象=1行で①②③…と採番する。
 * Excelのセル内改行として貼り付くよう、区切りは改行のみ (クリップボード側で処理済み)。
 */

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** 1始まりの番号を丸数字にする (⑳を超えたら (21) 形式) */
export function circledNumber(n: number): string {
  return n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
}

export const NO_DEFECT_TEXT = "点検の結果、不具合の指摘なし。";

export interface FormatOptions {
  /** 事象が0件のときの文言。アフターメンテナンスでは空文字にして手入力してもらう */
  emptyText?: string;
}

/**
 * 事象の一覧と点検員メモから、アフター受付内容の本文を組み立てる。
 * - 事象が2件以上なら「①事象」「②事象」…を改行で並べる
 * - 1件だけなら番号を付けない
 * - 0件なら「不具合の指摘なし」(emptyText で変えられる)
 * - メモがあれば末尾に「メモ: …」の行を追加する
 */
export function formatPhenomena(
  items: string[],
  notes: string[] = [],
  options: FormatOptions = {},
): string {
  const clean = items.map((s) => s.trim().replace(/[。\s]+$/, "")).filter(Boolean);
  const noteLines = notes
    .map((s) => s.trim().replace(/[。\s]+$/, ""))
    .filter(Boolean)
    .map((s) => `メモ: ${s}`);

  const emptyText = options.emptyText ?? NO_DEFECT_TEXT;
  const body =
    clean.length === 0
      ? emptyText
        ? [emptyText]
        : []
      : clean.length === 1
        ? [clean[0]]
        : clean.map((s, i) => `${circledNumber(i + 1)}${s}`);

  return [...body, ...noteLines].join("\n");
}
