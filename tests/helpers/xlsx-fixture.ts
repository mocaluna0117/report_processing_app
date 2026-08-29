// テスト用の xlsx を組み立てる (実ファイルは個人情報を含むため使わない)。
import { zipSync, strToU8 } from "fflate";

export interface FixtureSheet {
  name: string;
  rows: (string | number | null)[][];
}

export interface FixtureOptions {
  /** shared: 共有文字列 (助っ人クラウド形式) / inline: インライン文字列 (DX形式) */
  mode?: "shared" | "inline";
  /** シートのパートを連番以外にして、rels 経由の解決を試す */
  sheetPaths?: string[];
  /** 共有文字列にふりがな (rPh) を混ぜる */
  withRuby?: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const colName = (i: number) => {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

export function buildXlsx(sheets: FixtureSheet[], options: FixtureOptions = {}): Uint8Array {
  const mode = options.mode ?? "shared";
  const paths = options.sheetPaths ?? sheets.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`);
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const intern = (s: string) => {
    const hit = sharedIndex.get(s);
    if (hit !== undefined) return hit;
    const i = shared.length;
    shared.push(s);
    sharedIndex.set(s, i);
    return i;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            if (value === null || value === "") return "";
            const ref = `${colName(c)}${r + 1}`;
            if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
            if (mode === "inline") {
              return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
            }
            return `<c r="${ref}" t="s"><v>${intern(value)}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map(
      (s, i) =>
        `<si><t xml:space="preserve">${esc(s)}</t>${
          options.withRuby && i === 0 ? `<rPh sb="0" eb="1"><t>ふりがな</t></rPh>` : ""
        }</si>`,
    )
    .join("")}</sst>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${paths
    .map(
      (p, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${p.replace(/^xl\//, "")}"/>`,
    )
    .join("")}<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/sharedStrings.xml": strToU8(sharedXml),
  };
  paths.forEach((p, i) => {
    files[p] = strToU8(sheetXml[i]);
  });
  return zipSync(files);
}
