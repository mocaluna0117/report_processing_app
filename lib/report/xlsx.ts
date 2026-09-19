// 完了報告書のxlsxを、テンプレート (public/report/completion-report.xlsx) の
// 必要なセルだけ書き換えて作る。シート構成・書式・印刷設定はテンプレートのまま。
import { unzipSync, zipSync } from "fflate";
import { APPENDIX_ROW_HEIGHTS, appendixSlots } from "@/lib/report/layout/appendix-sheet";
import { APPENDIX_SLOTS, type AppendixItem, type ReportData } from "@/lib/report/model";
import {
  ReportTemplateError,
  escapeXmlText,
  ensureCellXf,
  replaceRowsFrom,
  setBoolean,
  setDimension,
  setFormulaCache,
  setInlineString,
  setMergeCells,
  setPrintArea,
} from "@/lib/report/sheet-xml";

const SHEET_INPUT = "xl/worksheets/sheet1.xml";
const SHEET_MAIN = "xl/worksheets/sheet3.xml";
const SHEET_APPENDIX = "xl/worksheets/sheet4.xml";
const WORKBOOK = "xl/workbook.xml";
const STYLES = "xl/styles.xml";
const REQUIRED_PARTS = [SHEET_INPUT, SHEET_MAIN, SHEET_APPENDIX, WORKBOOK, STYLES];

/** 入力シートの入力欄 (B列ラベル・C列値) */
const INPUT_CELLS = {
  pj: "C4",
  propertyName: "C5",
  ownerLine: "C6",
  handoverDate: "C7",
  address: "C8",
  phone1: "C9",
  phone2: "C10",
  receptionDate: "C12",
  receptionist: "C13",
} as const;
/** 入力シートの指示内容 (№ + 本文) */
const INPUT_NO_ROWS = [17, 18, 19, 20, 21];
/** 本紙の表示欄 (入力シートを参照する数式) → 入力シートのどの値に対応するか */
const MAIN_CACHE: [string, keyof typeof INPUT_CELLS][] = [
  ["D5", "pj"],
  ["O5", "handoverDate"],
  ["D6", "propertyName"],
  ["D7", "ownerLine"],
  ["D8", "address"],
  ["D9", "phone1"],
  ["O9", "phone2"],
  ["D13", "receptionDate"],
  ["M13", "receptionist"],
];
/** 本紙の指示内容の枠 (№, 本文, 作業内容側の№) */
const MAIN_SLOT_CELLS = [
  { no: "B16", text: "C16", workNo: "B23" },
  { no: "B17", text: "C17", workNo: "B24" },
  { no: "B18", text: "C18", workNo: "B25" },
  { no: "B19", text: "C19", workNo: "B26" },
  { no: "B20", text: "C20", workNo: "B27" },
];
/** 立会・受付項目のチェックボックス */
const CHECKBOX_CELLS = {
  attendance: { owner: "D11", family: "G11", other: "K11" },
  categories: {
    inspection: "D12",
    after: "G12",
    paid: "K12",
    direct: "N12",
    free: "Q12",
  },
} as const;
/** 別紙: 見出し */
const APPENDIX_CELLS = { property: "A2", owner: "A3", title: "A4" } as const;
/** 別紙の枠 (項目行 + 補足の細い欄 + 対応結果行) が始まる行 */
const APPENDIX_FIRST_ROW = 6;
const APPENDIX_RESULT_TEXT = "対応結果：";
/** 別紙の枠に使うテンプレートの書式番号 (A列=項目/対応結果、B列=チェック欄) */
const APPENDIX_STYLES = { item: 41, result: 42, checkTop: 70, checkMiddle: 68, checkBottom: 69 };
/**
 * 補足の細い欄の書式。テンプレートに無いので styles.xml に足す。
 * 項目行と同じ游ゴシック11pt (fontId 32)、左右 thin・下 hair・上なし (borderId 35) で、
 * 項目行の下 hair と対応結果行の上 hair に挟まれて細い欄に見える。
 */
const APPENDIX_SUPPLEMENT_XF =
  '<xf numFmtId="0" fontId="32" fillId="0" borderId="35" xfId="2" applyBorder="1" applyAlignment="1">' +
  "<alignment vertical=\"center\"/></xf>";
/** ZIP内の更新日時。固定して、同じ内容なら同じバイト列になるようにする */
const FIXED_MTIME = new Date(Date.UTC(2026, 0, 1));

function patchInputSheet(xml: string, data: ReportData): string {
  let out = xml;
  const values: Record<keyof typeof INPUT_CELLS, string> = {
    pj: data.pj,
    propertyName: data.propertyName,
    ownerLine: data.ownerLine,
    handoverDate: data.handoverDate,
    address: data.address,
    phone1: data.phone1,
    phone2: data.phone2,
    receptionDate: data.receptionDate,
    receptionist: data.receptionist,
  };
  for (const [key, ref] of Object.entries(INPUT_CELLS)) {
    out = setInlineString(out, ref, values[key as keyof typeof INPUT_CELLS]);
  }
  data.main.forEach((slot, i) => {
    const row = INPUT_NO_ROWS[i];
    out = setInlineString(out, `B${row}`, slot.no);
    out = setInlineString(out, `C${row}`, slot.text);
  });
  return out;
}

function patchMainSheet(xml: string, data: ReportData): string {
  let out = xml;
  const values: Record<keyof typeof INPUT_CELLS, string> = {
    pj: data.pj,
    propertyName: data.propertyName,
    ownerLine: data.ownerLine,
    handoverDate: data.handoverDate,
    address: data.address,
    phone1: data.phone1,
    phone2: data.phone2,
    receptionDate: data.receptionDate,
    receptionist: data.receptionist,
  };
  for (const [ref, key] of MAIN_CACHE) {
    out = setFormulaCache(out, ref, values[key]);
  }
  data.main.forEach((slot, i) => {
    const cells = MAIN_SLOT_CELLS[i];
    out = setFormulaCache(out, cells.no, slot.no);
    out = setFormulaCache(out, cells.text, slot.text);
    out = setFormulaCache(out, cells.workNo, slot.no);
  });
  for (const [group, refs] of Object.entries(CHECKBOX_CELLS)) {
    for (const [key, ref] of Object.entries(refs)) {
      const checked = (data.options as unknown as Record<string, Record<string, boolean>>)[group][key];
      out = setBoolean(out, ref, checked);
    }
  }
  return out;
}

/** セル1個。空文字なら値を持たない空セル */
function cellXml(ref: string, style: number, text: string): string {
  if (!text) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`;
}

function rowXml(row: number, cells: string, height?: number): string {
  const ht = height === undefined ? "" : ` ht="${height}" customHeight="1"`;
  return `<row r="${row}" spans="1:2"${ht}>${cells}</row>`;
}

/**
 * 別紙の枠の行 (6行目以降) を組み立てる。
 * 1枠 = 「項目行 + 補足のある枠だけ細い欄 + 対応結果行」で、チェック欄 (B列) はその全部の行にまたがる。
 */
export function appendixRowsXml(
  items: readonly AppendixItem[],
  supplementStyle: number,
): { rows: string; merges: string[]; lastRow: number } {
  const rows: string[] = [];
  const merges: string[] = [];
  let row = APPENDIX_FIRST_ROW;
  for (const slot of appendixSlots(items)) {
    const top = row;
    rows.push(
      rowXml(
        row,
        cellXml(`A${row}`, APPENDIX_STYLES.item, slot.text) +
          cellXml(`B${row}`, APPENDIX_STYLES.checkTop, ""),
      ),
    );
    row++;
    if (slot.supplement) {
      rows.push(
        rowXml(
          row,
          cellXml(`A${row}`, supplementStyle, slot.supplement) +
            cellXml(`B${row}`, APPENDIX_STYLES.checkMiddle, ""),
          APPENDIX_ROW_HEIGHTS.supplement,
        ),
      );
      row++;
    }
    rows.push(
      rowXml(
        row,
        // 「対応結果：」は項目がある枠だけ残す (見本の別紙と同じ)
        cellXml(`A${row}`, APPENDIX_STYLES.result, slot.text ? APPENDIX_RESULT_TEXT : "") +
          cellXml(`B${row}`, APPENDIX_STYLES.checkBottom, ""),
        APPENDIX_ROW_HEIGHTS.result,
      ),
    );
    merges.push(`B${top}:B${row}`);
    row++;
  }
  return { rows: rows.join(""), merges, lastRow: row - 1 };
}

function patchAppendixSheet(
  xml: string,
  data: ReportData,
  built: { rows: string; merges: string[]; lastRow: number },
): string {
  let out = xml;
  const appendix = data.appendix;
  // 物件名・施主名・タイトルは別紙を使わない場合も入れておく (前の点検時期の文字が残らないように)
  out = setInlineString(out, APPENDIX_CELLS.property, `物件名：${data.propertyName}`, "別紙");
  out = setInlineString(
    out,
    APPENDIX_CELLS.owner,
    data.ownerName ? `施主名：${data.ownerName.replace(/　/g, " ")}様` : "施主名：",
    "別紙",
  );
  out = setInlineString(out, APPENDIX_CELLS.title, appendix?.title ?? "", "別紙");
  out = replaceRowsFrom(out, APPENDIX_FIRST_ROW, built.rows);
  out = setMergeCells(out, built.merges);
  return setDimension(out, `A1:B${built.lastRow}`);
}

/**
 * テンプレートのバイト列と値から、完了報告書のxlsxを作る。
 * 触るのは入力シート・本紙・別紙の3パーツだけで、他は元のバイト列のまま詰め直す。
 */
export function buildReportXlsx(template: Uint8Array, data: ReportData): Uint8Array {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(template);
  } catch (e) {
    throw new ReportTemplateError(
      `テンプレートを展開できません (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  for (const name of REQUIRED_PARTS) {
    if (!parts[name]) throw new ReportTemplateError(`テンプレートに ${name} がありません`);
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const patched: Record<string, Uint8Array> = { ...parts };
  patched[SHEET_INPUT] = encoder.encode(patchInputSheet(decoder.decode(parts[SHEET_INPUT]), data));
  patched[SHEET_MAIN] = encoder.encode(patchMainSheet(decoder.decode(parts[SHEET_MAIN]), data));

  // 別紙は枠の行そのものを組み立て直す (補足のある項目は細い欄が1行増える)。
  // ★補足があるときだけ書式 (styles.xml) と印刷範囲 (workbook.xml) も触る。
  //   無ければテンプレートのバイト列をそのまま残す
  // Excelの別紙は今までどおり12件まで (13件目以降はPDFだけに載る。model.ts が注意を出す)
  const items = (data.appendix?.items ?? []).slice(0, APPENDIX_SLOTS);
  const stylesXml = decoder.decode(parts[STYLES]);
  const styles = items.some((item) => item.supplement)
    ? ensureCellXf(stylesXml, APPENDIX_SUPPLEMENT_XF)
    : { xml: stylesXml, index: -1 };
  const built = appendixRowsXml(items, styles.index);
  if (styles.xml !== stylesXml) patched[STYLES] = encoder.encode(styles.xml);
  patched[SHEET_APPENDIX] = encoder.encode(
    patchAppendixSheet(decoder.decode(parts[SHEET_APPENDIX]), data, built),
  );
  const workbookXml = decoder.decode(parts[WORKBOOK]);
  const printArea = setPrintArea(workbookXml, "別紙", `$A$1:$B$${built.lastRow}`);
  if (printArea !== workbookXml) patched[WORKBOOK] = encoder.encode(printArea);

  // 元のパーツ順を保つ。印刷設定 (.bin) は圧縮しても縮まないので無圧縮で入れる
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const name of Object.keys(parts)) {
    entries[name] = [patched[name], { level: name.endsWith(".bin") ? 0 : 6 }];
  }
  return zipSync(entries, { mtime: FIXED_MTIME });
}
