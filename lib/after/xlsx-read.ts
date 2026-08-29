// xlsx (Office Open XML) をライブラリ無しで読む。
// 顧客データの取り込み専用で、必要なのは「シートの値を文字列で得る」ことだけ。
// lib/report/sheet-xml.ts と同じく正規表現で扱う:
// - vitest は node 環境で DOMParser が無く、@xmldom/xmldom は開発用依存のみ
// - 使う要素は sst/si/t と row/c/v/is という規則的な部分集合だけ
import { unzipSync } from "fflate";

export interface SheetTable {
  name: string;
  /** rows[行][列]。空セルは "" で埋め、行内の列数は最大列に揃える */
  rows: string[][];
}

export class XlsxReadError extends Error {}

/** ZIP (xlsx) か。判定に失敗したら csv として読ませる */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** 旧形式 (.xls) は別物なので、無言で失敗せず案内する */
export function isLegacyXls(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  );
}

const decoder = new TextDecoder();

function unescapeXml(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name as string] ?? "";
  });
}

/** <si> や <is> の中身。ふりがな (<rPh>) は表示されないので落とす */
function textOf(xml: string): string {
  const withoutRuby = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of withoutRuby.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    out += unescapeXml(m[1]);
  }
  return out;
}

function readSharedStrings(parts: Record<string, Uint8Array>): string[] {
  const raw = parts["xl/sharedStrings.xml"];
  if (!raw) return [];
  const xml = decoder.decode(raw);
  const list: string[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?si\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) {
    list.push(m[1] ? textOf(m[1]) : "");
  }
  return list;
}

/** "B3" → 1 (0始まりの列番号) */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** シート名 → パート名。rels が読めない古い出力では sheet1.xml にフォールバックする */
function sheetParts(parts: Record<string, Uint8Array>): { name: string; path: string }[] {
  const workbook = parts["xl/workbook.xml"];
  if (!workbook) throw new XlsxReadError("xlsx の構成が想定と違います (xl/workbook.xml がありません)");
  const relsRaw = parts["xl/_rels/workbook.xml.rels"];
  const rels = new Map<string, string>();
  if (relsRaw) {
    const relsXml = decoder.decode(relsRaw);
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0])?.[1];
      const target = /Target="([^"]+)"/.exec(m[0])?.[1];
      if (id && target) rels.set(id, target);
    }
  }
  const out: { name: string; path: string }[] = [];
  for (const m of decoder.decode(workbook).matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const target = rels.get(rid);
    const path = target
      ? target.startsWith("/")
        ? target.slice(1)
        : target.startsWith("xl/")
          ? target
          : `xl/${target.replace(/^\.\//, "")}`
      : `xl/worksheets/sheet${out.length + 1}.xml`;
    if (parts[path]) out.push({ name, path });
  }
  return out;
}

function readSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const body = rowMatch[1] ?? "";
    const cells: string[] = [];
    let next = 0;
    for (const c of body.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      // r が省略されたセルは直前の次の列にある
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const value = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let text = "";
      if (type === "s") {
        text = value ? (shared[Number(value)] ?? "") : "";
      } else if (type === "inlineStr") {
        text = textOf(inner);
      } else if (type === "b") {
        text = value === "1" ? "TRUE" : "FALSE";
      } else if (type === "e") {
        text = "";
      } else {
        text = value ? unescapeXml(value) : "";
      }
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
    rows.push(cells);
  }
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((r) => {
    const filled = [...r];
    while (filled.length < width) filled.push("");
    return filled;
  });
}

/** すべてのシートを読む (先頭から順)。値はすべて文字列 */
export function readXlsxSheets(bytes: Uint8Array): SheetTable[] {
  if (isLegacyXls(bytes)) {
    throw new XlsxReadError(
      "古い形式 (.xls) は読み込めません。Excelで「.xlsx」として保存し直してください",
    );
  }
  if (!isZip(bytes)) throw new XlsxReadError("xlsx として読み込めませんでした");
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch (e) {
    throw new XlsxReadError(`xlsx を展開できません (${e instanceof Error ? e.message : String(e)})`);
  }
  const shared = readSharedStrings(parts);
  return sheetParts(parts).map(({ name, path }) => ({
    name,
    rows: readSheet(decoder.decode(parts[path]), shared),
  }));
}
