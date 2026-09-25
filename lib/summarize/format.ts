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
  /**
   * 事象ごとの補足の並び (items と同じ並び。1つの事象に何行でも。空の並びなら補足なし。2026-09-25)。
   * 補足1つにつき、事象の次に「補足: …」の行を1行ずつ入れる (完了報告書では「・…」の行が1つずつ)。
   */
  supplements?: readonly (readonly string[])[];
}

/** 補足の行の頭。読み取りは lib/summary.ts の SUPPLEMENT_LINE が受け持つ */
export const SUPPLEMENT_PREFIX = "補足: ";

/**
 * 補足の文を整える。前後の空白と、先頭に打った「・」を落とす。
 * ★完了報告書では「・」を付けて載せるので、打った「・」を残すと「・・」になる
 */
export function cleanSupplement(text: string): string {
  return text.trim().replace(/^[・･•]+\s*/, "").trim();
}

/**
 * 事象の一覧と点検員メモから、アフター受付内容の本文を組み立てる。
 * - 事象が2件以上なら「①事象」「②事象」…を改行で並べる
 * - 1件だけなら番号を付けない
 * - 0件なら「不具合の指摘なし」(emptyText で変えられる)
 * - 補足があれば、その事象の次に「補足: …」の行を補足の数だけ入れる
 * - メモがあれば末尾に「メモ: …」の行を追加する
 */
export function formatPhenomena(
  items: string[],
  notes: string[] = [],
  options: FormatOptions = {},
): string {
  // ★事象と補足は対で扱う (空の事象を落とすときに補足だけ残ると、別の事象の補足になってしまう)
  const clean = items
    .map((s, i) => ({
      text: s.trim().replace(/[。\s]+$/, ""),
      supplements: (options.supplements?.[i] ?? []).map(cleanSupplement).filter(Boolean),
    }))
    .filter((pair) => pair.text);
  const noteLines = notes
    .map((s) => s.trim().replace(/[。\s]+$/, ""))
    .filter(Boolean)
    .map((s) => `メモ: ${s}`);

  const emptyText = options.emptyText ?? NO_DEFECT_TEXT;
  const withSupplements = (head: string, supplements: readonly string[]) => [
    head,
    ...supplements.map((s) => `${SUPPLEMENT_PREFIX}${s}`),
  ];
  const body =
    clean.length === 0
      ? emptyText
        ? [emptyText]
        : []
      : clean.length === 1
        ? withSupplements(clean[0].text, clean[0].supplements)
        : clean.flatMap((pair, i) =>
            withSupplements(`${circledNumber(i + 1)}${pair.text}`, pair.supplements),
          );

  return [...body, ...noteLines].join("\n");
}
