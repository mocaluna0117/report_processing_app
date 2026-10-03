/**
 * 支出報告書の xlsx を、テンプレート (public/report/expense-report.xlsx) から作る。
 *
 * テンプレートは利用者の見本の 1〜18 行目（合計欄・担当者別件数の表・1つ目の表の見出し）だけを残したもの
 * （scripts/build_expense_template.py）。17 行目から下を、表ごとに「見出し2行＋行」で組み立て直す。
 * 表は RIZAP対象 → RIZAP対象外 → エンド立会 の順で、間に空行は入れない（見本と同じ）。
 *
 * ★書式は見本のセルの書式番号をそのまま使う（行の罫線は細い点線、表の最後の行だけ下が太線）。
 * ★数式（支出金額・合計・担当者別の計）は残し、結果も書く。開いたときにも計算し直させる（fullCalcOnLoad）。
 */
import { unzipSync, zipSync } from "fflate";
import {
  ReportTemplateError,
  escapeXmlText,
  replaceRowsFrom,
  setDimension,
  setFormulaNumber,
  setInlineString,
  setMergeCells,
  setNumber,
} from "@/lib/report/sheet-xml";
import type { ExpenseReport, ReportRow } from "./build";

export const EXPENSE_TEMPLATE_PATH = "/report/expense-report.xlsx";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SHEET = "xl/worksheets/sheet1.xml";
const WORKBOOK = "xl/workbook.xml";
const APP = "docProps/app.xml";
const PLACEHOLDER = "支出報告";
const HEADER_ROW = 17;
const FIXED_MTIME = new Date(Date.UTC(2026, 0, 1));

/** 行の書式（見本の 19 行目）と、表の最後の行の書式（見本の最終行。下が太線） */
const ROW_STYLE: Record<string, number> = {
  A: 52, B: 53, C: 54, D: 55, E: 56, F: 56, G: 56, H: 57, I: 58, J: 57, K: 59, L: 59, M: 59, N: 60, O: 116, P: 114, Q: 117,
};
const LAST_ROW_STYLE: Record<string, number> = {
  A: 158, B: 159, C: 160, D: 161, E: 162, F: 162, G: 162, H: 163, I: 164, J: 165, K: 166, L: 166, M: 166, N: 167, O: 168, P: 169, Q: 170,
};
/** 見出しで縦に2行を結ぶ列（K〜M は「受注-①」で横に結ぶ） */
const HEADER_TALL = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "N", "O", "P", "Q"];
/** 担当者別件数の表（7〜14行目が名簿、15行目が合計） */
const STAFF_FIRST_ROW = 7;

const text = (ref: string, style: number, value: string) =>
  value
    ? `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`
    : `<c r="${ref}" s="${style}"/>`;
const num = (ref: string, style: number, value: number | null) =>
  value === null ? `<c r="${ref}" s="${style}"/>` : `<c r="${ref}" s="${style}"><v>${value}</v></c>`;

function dataRowXml(r: number, row: ReportRow, last: boolean): string {
  const s = last ? LAST_ROW_STYLE : ROW_STYLE;
  const cells = [
    text(`A${r}`, s.A, row.no),
    row.handoverAt === null ? text(`B${r}`, s.B, "不明") : num(`B${r}`, s.B, row.handoverAt),
    num(`C${r}`, s.C, row.completedAt),
    num(`D${r}`, s.D, row.division),
    num(`E${r}`, s.E, row.pj),
    num(`F${r}`, s.F, row.site),
    num(`G${r}`, s.G, row.branch),
    text(`H${r}`, s.H, row.propertyName),
    text(`I${r}`, s.I, row.category),
    text(`J${r}`, s.J, row.summary),
    num(`K${r}`, s.K, 0),
    num(`L${r}`, s.L, 0),
    num(`M${r}`, s.M, 0),
    num(`N${r}`, s.N, row.cost),
    `<c r="O${r}" s="${s.O}"><f>(K${r}+L${r}+M${r})-N${r}</f><v>${-row.cost}</v></c>`,
    text(`P${r}`, s.P, row.staff),
    text(`Q${r}`, s.Q, row.note),
  ];
  return `<row r="${r}" spans="1:17" ht="18" customHeight="1">${cells.join("")}</row>`;
}

/** テンプレートの 17・18 行目（見出し）を、行番号を付け替えて写す */
function headerRowsXml(template: { top: string; bottom: string }, r: number): string {
  const renumber = (xml: string, from: number, to: number) =>
    xml
      .replace(new RegExp(`(<row r=")${from}(")`), `$1${to}$2`)
      .replace(new RegExp(`(<c r="[A-Z]+)${from}(")`, "g"), `$1${to}$2`);
  return renumber(template.top, HEADER_ROW, r) + renumber(template.bottom, HEADER_ROW + 1, r + 1);
}

function pickRow(xml: string, r: number): string {
  const m = new RegExp(`<row r="${r}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`).exec(xml);
  if (!m) throw new ReportTemplateError(`テンプレートに ${r} 行目（表の見出し）がありません`);
  return m[0];
}

function existingMerges(xml: string, belowRow: number): string[] {
  return [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)]
    .map((m) => m[1])
    .filter((ref) => [...ref.matchAll(/\d+/g)].every((d) => Number(d[0]) < belowRow));
}

function renameSheet(xml: string, name: string): string {
  return xml
    .replaceAll(`name="${PLACEHOLDER}"`, `name="${escapeXmlText(name)}"`)
    .replaceAll(`'${PLACEHOLDER}'!`, `'${escapeXmlText(name)}'!`)
    .replaceAll(`<vt:lpstr>${PLACEHOLDER}</vt:lpstr>`, `<vt:lpstr>${escapeXmlText(name)}</vt:lpstr>`);
}

function setDefinedRange(workbookXml: string, defined: string, range: string): string {
  const pattern = new RegExp(`(<definedName name="${defined.replace(/\./g, "\\.")}"[^>]*>'[^']*'!)[^<]*(</definedName>)`);
  if (!pattern.test(workbookXml)) throw new ReportTemplateError(`テンプレートに ${defined} がありません`);
  return workbookXml.replace(pattern, (_m, open: string, close: string) => `${open}${range}${close}`);
}

export function buildExpenseXlsx(template: Uint8Array, report: ExpenseReport): Uint8Array {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(template);
  } catch (e) {
    throw new ReportTemplateError(`テンプレートを展開できません (${e instanceof Error ? e.message : String(e)})`);
  }
  for (const name of [SHEET, WORKBOOK]) {
    if (!parts[name]) throw new ReportTemplateError(`テンプレートに ${name} がありません`);
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sheet = decoder.decode(parts[SHEET]);
  const header = { top: pickRow(sheet, HEADER_ROW), bottom: pickRow(sheet, HEADER_ROW + 1) };

  // --- 17 行目から下を組み立てる
  const rows: string[] = [];
  const merges = existingMerges(sheet, HEADER_ROW);
  let r = HEADER_ROW;
  for (const section of report.sections) {
    rows.push(headerRowsXml(header, r));
    for (const col of HEADER_TALL) merges.push(`${col}${r}:${col}${r + 1}`);
    merges.push(`K${r}:M${r}`);
    r += 2;
    section.rows.forEach((row, i) => {
      rows.push(dataRowXml(r, row, i === section.rows.length - 1));
      r += 1;
    });
  }
  const lastRow = r - 1;
  sheet = replaceRowsFrom(sheet, HEADER_ROW, rows.join(""), "支出報告");
  sheet = setMergeCells(sheet, merges, "支出報告");
  sheet = setDimension(sheet, `A1:Q${lastRow}`, "支出報告");

  // --- タイトル・合計欄・担当者別件数
  sheet = setInlineString(sheet, "A1", report.title, "支出報告");
  const sumTo = Math.max(300, lastRow);
  sheet = setFormulaNumber(sheet, "N4", `SUM(K19:M${sumTo})`, 0, "支出報告");
  sheet = setFormulaNumber(sheet, "O4", `SUM(N19:N${sumTo})`, report.totalCost, "支出報告");
  sheet = setFormulaNumber(sheet, "P4", "N4-O4", -report.totalCost, "支出報告");
  const totals = { C: 0, D: 0, E: 0, G: 0 };
  report.staff.forEach((s, i) => {
    const row = STAFF_FIRST_ROW + i;
    sheet = setNumber(sheet, `C${row}`, s.rizap, "支出報告");
    sheet = setNumber(sheet, `D${row}`, s.other, "支出報告");
    sheet = setNumber(sheet, `E${row}`, s.end, "支出報告");
    sheet = setFormulaNumber(sheet, `G${row}`, `SUM(C${row}:F${row})`, s.rizap + s.other + s.end, "支出報告");
    totals.C += s.rizap;
    totals.D += s.other;
    totals.E += s.end;
    totals.G += s.rizap + s.other + s.end;
  });
  const sumRow = STAFF_FIRST_ROW + report.staff.length;
  const lastStaff = sumRow - 1;
  for (const col of ["C", "D", "E", "G"] as const) {
    sheet = setFormulaNumber(sheet, `${col}${sumRow}`, `SUM(${col}${STAFF_FIRST_ROW}:${col}${lastStaff})`, totals[col], "支出報告");
  }

  // --- シート名・印刷範囲・絞り込みの範囲
  const sheetName = `${report.month}月度支出報告`;
  let workbook = renameSheet(decoder.decode(parts[WORKBOOK]), sheetName);
  workbook = setDefinedRange(workbook, "_xlnm.Print_Area", `$A$1:$Q$${lastRow}`);
  workbook = setDefinedRange(workbook, "_xlnm._FilterDatabase", `$A$18:$S$${lastRow}`);

  const patched: Record<string, Uint8Array> = { ...parts };
  patched[SHEET] = encoder.encode(sheet);
  patched[WORKBOOK] = encoder.encode(workbook);
  if (parts[APP]) patched[APP] = encoder.encode(renameSheet(decoder.decode(parts[APP]), sheetName));

  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const name of Object.keys(parts)) entries[name] = [patched[name], { level: 6 }];
  return zipSync(entries, { mtime: FIXED_MTIME });
}
