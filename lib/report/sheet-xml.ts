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

/**
 * 指定した行以降の <row> をまとめて差し替える (別紙の枠を組み立て直すため)。
 * ★行を足すのは別紙だけ。本紙・入力シートは数式やチェックボックスが載っているので触らない。
 */
export function replaceRowsFrom(
  xml: string,
  firstRow: number,
  rows: string,
  what = "別紙",
): string {
  const open = xml.indexOf("<sheetData>");
  const close = xml.indexOf("</sheetData>");
  if (open < 0 || close < 0) throw new ReportTemplateError(`${what}: sheetData が見つかりません`);
  const body = xml.slice(open + "<sheetData>".length, close);
  const kept: string[] = [];
  const pattern = /<row r="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g;
  let matched = 0;
  for (const m of body.matchAll(pattern)) {
    matched += m[0].length;
    if (Number(m[1]) < firstRow) kept.push(m[0]);
  }
  if (body.trim().length !== matched) {
    throw new ReportTemplateError(`${what}: 行の並びを読み取れません (テンプレートの構造が変わっていませんか)`);
  }
  return `${xml.slice(0, open)}<sheetData>${kept.join("")}${rows}</sheetData>${xml.slice(close + "</sheetData>".length)}`;
}

/** 結合セルの一覧を差し替える */
export function setMergeCells(xml: string, refs: readonly string[], what = "別紙"): string {
  const pattern = /<mergeCells count="\d+">[\s\S]*?<\/mergeCells>/;
  if (!pattern.test(xml)) throw new ReportTemplateError(`${what}: mergeCells が見つかりません`);
  const body = refs.map((ref) => `<mergeCell ref="${ref}"/>`).join("");
  return xml.replace(pattern, refs.length > 0 ? `<mergeCells count="${refs.length}">${body}</mergeCells>` : "");
}

/** シートの使用範囲 (dimension) を差し替える */
export function setDimension(xml: string, ref: string, what = "別紙"): string {
  const pattern = /<dimension ref="[^"]*"\/>/;
  if (!pattern.test(xml)) throw new ReportTemplateError(`${what}: dimension が見つかりません`);
  return xml.replace(pattern, `<dimension ref="${ref}"/>`);
}

/** 印刷範囲 (workbook.xml の定義名) を差し替える */
export function setPrintArea(
  workbookXml: string,
  sheetName: string,
  ref: string,
  what = "ブック",
): string {
  const pattern = new RegExp(
    `(<definedName name="_xlnm.Print_Area"[^>]*>)${sheetName}!\\$[^<]*(</definedName>)`,
  );
  if (!pattern.test(workbookXml)) {
    throw new ReportTemplateError(`${what}: ${sheetName} の印刷範囲が見つかりません`);
  }
  // ref には $A$1 のような「$数字」が入るので、置換文字列ではなく関数で入れる
  return workbookXml.replace(pattern, (_m, open: string, close: string) =>
    `${open}${sheetName}!${ref}${close}`,
  );
}

/**
 * セル書式 (cellXfs) に1つ足して、その番号を返す。
 * 同じ内容の書式が既にあればそれを使う (呼ぶたびに増やさない)。
 */
export function ensureCellXf(stylesXml: string, xf: string): { xml: string; index: number } {
  const section = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!section) throw new ReportTemplateError("styles.xml: cellXfs が見つかりません");
  const entries = [...section[2].matchAll(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => m[0]);
  const found = entries.indexOf(xf);
  if (found >= 0) return { xml: stylesXml, index: found };
  const replaced = `<cellXfs count="${entries.length + 1}">${section[2]}${xf}</cellXfs>`;
  return { xml: stylesXml.replace(section[0], replaced), index: entries.length };
}
