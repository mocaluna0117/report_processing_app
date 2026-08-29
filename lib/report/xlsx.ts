// 完了報告書のxlsxを、テンプレート (public/report/completion-report.xlsx) の
// 必要なセルだけ書き換えて作る。シート構成・書式・印刷設定はテンプレートのまま。
import { unzipSync, zipSync } from "fflate";
import { APPENDIX_SLOTS, type ReportData } from "@/lib/report/model";
import {
  ReportTemplateError,
  setBoolean,
  setFormulaCache,
  setInlineString,
} from "@/lib/report/sheet-xml";

const SHEET_INPUT = "xl/worksheets/sheet1.xml";
const SHEET_MAIN = "xl/worksheets/sheet3.xml";
const SHEET_APPENDIX = "xl/worksheets/sheet4.xml";
const REQUIRED_PARTS = [SHEET_INPUT, SHEET_MAIN, SHEET_APPENDIX, "xl/workbook.xml", "xl/styles.xml"];

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
/** 別紙: 見出しと項目行 */
const APPENDIX_CELLS = { property: "A2", owner: "A3", title: "A4" } as const;
/** 別紙の項目行 A6, A8, … と、その下の「対応結果：」行 A7, A9, … */
const APPENDIX_ITEM_ROWS = Array.from({ length: APPENDIX_SLOTS }, (_, k) => 6 + 2 * k);
const APPENDIX_RESULT_TEXT = "対応結果：";
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

function patchAppendixSheet(xml: string, data: ReportData): string {
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
  APPENDIX_ITEM_ROWS.forEach((row, k) => {
    const text = appendix?.items[k] ?? "";
    out = setInlineString(out, `A${row}`, text, "別紙");
    // 「対応結果：」は項目がある対だけ残す (見本の別紙と同じ)
    out = setInlineString(out, `A${row + 1}`, text ? APPENDIX_RESULT_TEXT : "", "別紙");
  });
  return out;
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
  patched[SHEET_APPENDIX] = encoder.encode(
    patchAppendixSheet(decoder.decode(parts[SHEET_APPENDIX]), data),
  );

  // 元のパーツ順を保つ。印刷設定 (.bin) は圧縮しても縮まないので無圧縮で入れる
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const name of Object.keys(parts)) {
    entries[name] = [patched[name], { level: name.endsWith(".bin") ? 0 : 6 }];
  }
  return zipSync(entries, { mtime: FIXED_MTIME });
}
