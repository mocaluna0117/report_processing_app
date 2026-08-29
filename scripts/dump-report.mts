// 開発用: 架空データから完了報告書の xlsx / PDF を作って書き出す。
//   npx tsx scripts/dump-report.mts [出力先ディレクトリ] [--items N]
// 見本PDFと見比べるために使う (scripts/report_visual_diff.py)。
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "fflate";
import { buildReportData, DEFAULT_REPORT_OPTIONS, type ReportSource } from "../lib/report/model.ts";
import { buildReportPdf } from "../lib/report/pdf.ts";
import { buildReportXlsx } from "../lib/report/xlsx.ts";
import {
  ADDRESS_COL,
  COLUMNS,
  HANDOVER_COL,
  OWNER_COL,
  PJ_COL,
  PROPERTY_COL,
  RECEPTION_DATE_COL,
  RECEPTION_TYPE_COL,
  SUMMARY_COL,
} from "../lib/tsv.ts";

const outDir = process.argv[2] ?? ".cache/report";
const itemsArgIndex = process.argv.indexOf("--items");
const itemCount = itemsArgIndex > 0 ? Number(process.argv[itemsArgIndex + 1]) : 1;

/** 見本PDFと同じ配置になっているか確認するための架空データ */
const SAMPLE_ITEMS = [
  "1階洋室 天井クロス：クロス表面に凹凸あり（下地ジョイント部の不陸と思われる）",
  "2階リビング 壁クロス：クロス継ぎ目の浮き（剥がれ）あり",
  "2階リビング 壁クロス：クロス表面に凹凸あり（下地ジョイント部の不陸と思われる）",
  "2階リビング 壁クロス：クロスジョイント部分に隙間あり",
  "2階階段室：ササラ木口部分の剥がれあり",
  "2階リビング 天井入隅：凹凸あり（今後剥がれが発生しないか懸念あり）",
];

function source(count: number): ReportSource {
  const cells = COLUMNS.map(() => "");
  cells[PJ_COL] = "2101190101";
  cells[RECEPTION_TYPE_COL] = "1年";
  cells[RECEPTION_DATE_COL] = "2026/7/4";
  cells[PROPERTY_COL] = "564.架空市架空町2-23-23A号棟";
  cells[OWNER_COL] = "山田　太郎";
  cells[ADDRESS_COL] = "東京都架空市架空町2-23-22";
  cells[HANDOVER_COL] = "2025/8/25";
  cells[SUMMARY_COL] = Array.from(
    { length: count },
    (_, i) => `${"①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭"[i] ?? `(${i + 1})`}${SAMPLE_ITEMS[i % SAMPLE_ITEMS.length]}`,
  ).join("\n");
  return {
    cells,
    mail: {
      ownerKana: "ヤマダ　タロウ",
      contacts: [
        { phone: "080-1234-5678", relation: "ご主人", confidence: "ok" },
        { phone: "090-2345-6789", relation: "奥様", confidence: "ok" },
      ],
    },
  };
}

const fontDir = join(process.cwd(), "public", "report", "fonts");
const files = readdirSync(fontDir);
const load = (prefix: string) =>
  gunzipSync(
    new Uint8Array(readFileSync(join(fontDir, files.find((f) => f.startsWith(prefix))!))),
  );

const data = buildReportData(source(itemCount), DEFAULT_REPORT_OPTIONS);
const { bytes, warnings } = await buildReportPdf(data, {
  regular: load("NotoSansJP-Regular"),
  bold: load("NotoSansJP-Bold"),
});
const template = new Uint8Array(
  readFileSync(join(process.cwd(), "public", "report", "completion-report.xlsx")),
);
const xlsx = buildReportXlsx(template, data);

mkdirSync(outDir, { recursive: true });
const suffix = itemCount >= 6 ? "-appendix" : "";
writeFileSync(join(outDir, `report${suffix}.pdf`), bytes);
writeFileSync(join(outDir, `report${suffix}.xlsx`), xlsx);
console.log(`書き出しました: ${outDir}/report${suffix}.pdf (${(bytes.length / 1024).toFixed(0)} KB) / report${suffix}.xlsx (${(xlsx.length / 1024).toFixed(0)} KB)`);
console.log("指示内容:", data.items.length, "件 / 別紙:", data.useAppendix ? "あり" : "なし");
for (const w of [...data.warnings, ...warnings]) console.log("  警告:", w);
