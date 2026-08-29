/**
 * xlsx (OOXML) のシートXMLを「既存のセルだけ差し替える」形で書き換える小さなユーティリティ。
 *
 * ExcelJS 等でワークブックを読み書きすると、テンプレートが持つ
 * セル・チェックボックス書式 (cellXfs の xfComplement 拡張)・featurePropertyBag・
 * customXml・印刷設定といったパーツが失われる。そのため XML を文字列のまま最小限だけ
 * 書き換える。対象セルはテンプレートに必ず存在する前提で、見つからなければ例外にする
 * (テンプレートを差し替えたときに黙って空の報告書が出るのを防ぐ)。
 */

export class ReportTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportTemplateError";
  }
}

/** XMLテキストのエスケープ。XML1.0で表現できない制御文字は捨てる */
export function escapeXmlText(s: string): string {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** セル1個にマッチする正規表現 (自己終了タグと子要素ありの両方) */
function cellPattern(ref: string): RegExp {
  return new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`, "g");
}

interface Cell {
  /** r 以外の属性 (s / t など) */
  attrs: string;
  /** 子要素 (自己終了タグなら undefined) */
  body?: string;
  start: number;
  end: number;
}

function findCell(xml: string, ref: string, what: string): Cell {
  const matches = [...xml.matchAll(cellPattern(ref))];
  if (matches.length !== 1) {
    throw new ReportTemplateError(
      `${what}: セル ${ref} が ${matches.length} 個見つかりました (1個であるべき)。テンプレートの構造が変わっていませんか`,
    );
  }
  const m = matches[0];
  return {
    attrs: m[1] ?? "",
    body: m[2],
    start: m.index,
    end: m.index + m[0].length,
  };
}

/** s="…" だけ残し、t="…" は落とした属性列を返す */
function styleAttr(attrs: string): string {
  const s = /\ss="(\d+)"/.exec(attrs);
  return s ? ` s="${s[1]}"` : "";
}

function replaceRange(xml: string, cell: Cell, replacement: string): string {
  return xml.slice(0, cell.start) + replacement + xml.slice(cell.end);
}

/**
 * 文字列を書き込む (共有文字列表を触らずに済む inlineStr で入れる)。
 * 空文字なら値を持たない空セルに戻す。
 */
export function setInlineString(xml: string, ref: string, text: string, what = "入力シート"): string {
  const cell = findCell(xml, ref, what);
  const s = styleAttr(cell.attrs);
  const body = text
    ? `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`
    : `<c r="${ref}"${s}/>`;
  return replaceRange(xml, cell, body);
}

/**
 * 数式セルのキャッシュ値だけを書き換える (数式はそのまま残す)。
 * 再計算しないビューアでも値が見えるようにするため。
 */
export function setFormulaCache(xml: string, ref: string, text: string, what = "本紙"): string {
  const cell = findCell(xml, ref, what);
  if (cell.body === undefined || !cell.body.includes("<f>")) {
    throw new ReportTemplateError(`${what}: セル ${ref} に数式がありません`);
  }
  const formula = /<f[^>]*>[\s\S]*?<\/f>/.exec(cell.body)?.[0];
  if (!formula) throw new ReportTemplateError(`${what}: セル ${ref} の数式を読み取れません`);
  const s = styleAttr(cell.attrs);
  const value = text ? `<v>${escapeXmlText(text)}</v>` : "<v/>";
  return replaceRange(xml, cell, `<c r="${ref}"${s} t="str">${formula}${value}</c>`);
}

/** チェックボックス (真偽値セル) の値を書き換える */
export function setBoolean(xml: string, ref: string, on: boolean, what = "本紙"): string {
  const cell = findCell(xml, ref, what);
  if (!/\st="b"/.test(cell.attrs)) {
    throw new ReportTemplateError(`${what}: セル ${ref} が真偽値セル (チェックボックス) ではありません`);
  }
  const s = styleAttr(cell.attrs);
  return replaceRange(xml, cell, `<c r="${ref}"${s} t="b"><v>${on ? 1 : 0}</v></c>`);
}
