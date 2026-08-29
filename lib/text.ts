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

/**
 * 氏名の姓名区切りを全角スペースにする (Excelの「お客様氏名」列の表記に合わせる)。
 * 結合PDFのファイル名は半角スペース指定なので、そちらには適用しない。
 */
export function toFullWidthSpace(s: string): string {
  return s.replace(/[ \t\u00a0]+/g, "　");
}

/** 「2025/9/26」→「2025/09/26」(メール文用のゼロ埋め表記)。日付形式でなければそのまま返す */
export function toDateZeroPad(s: string): string {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s.trim());
  if (!m) return s;
  return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
}

/**
 * 半角カタカナ (ｦ-ﾟ) を全角にする。「ｾｷｭﾚｱ」→「セキュレア」。
 * 濁点・半濁点の合成もするため、この範囲だけ NFKC を掛ける
 * (全体に NFKC を掛けると記号や丸数字まで変わってしまう)。
 */
export function toFullWidthKatakana(s: string): string {
  return s.replace(/[｡-ﾟ]+/g, (run) => run.normalize("NFKC"));
}

/** 前後の空白 (半角・全角・タブ・改行) を落とす。Excelのセルは全角スペース付きのことが多い */
export function trimWide(s: string): string {
  return s.replace(/^[\s　]+|[\s　]+$/g, "");
}
