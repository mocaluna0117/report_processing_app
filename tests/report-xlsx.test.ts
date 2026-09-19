import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORT_OPTIONS,
  buildReportData,
  type ReportOptions,
  type ReportSource,
} from "@/lib/report/model";
import { ReportTemplateError, setBoolean, setFormulaCache, setInlineString } from "@/lib/report/sheet-xml";
import { buildReportXlsx } from "@/lib/report/xlsx";
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
} from "@/lib/tsv";

const TEMPLATE_PATH = join(process.cwd(), "public", "report", "completion-report.xlsx");
const template = new Uint8Array(readFileSync(TEMPLATE_PATH));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** 架空データ */
function source(items: string[], over: Partial<Record<number, string>> = {}): ReportSource {
  const cells = COLUMNS.map(() => "");
  cells[PJ_COL] = "2101230101";
  cells[RECEPTION_TYPE_COL] = "1年";
  cells[RECEPTION_DATE_COL] = "2026/7/22";
  cells[PROPERTY_COL] = "653.架空町7-21-12A号棟";
  cells[OWNER_COL] = "山田　太郎";
  cells[ADDRESS_COL] = "東京都架空町7-21-11";
  cells[HANDOVER_COL] = "2025/9/26";
  cells[SUMMARY_COL] = items.join("\n");
  for (const [k, v] of Object.entries(over)) cells[Number(k)] = v ?? "";
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

function build(items: string[], options: ReportOptions = DEFAULT_REPORT_OPTIONS, over = {}) {
  const data = buildReportData(source(items, over), options);
  const parts = unzipSync(buildReportXlsx(template, data));
  return {
    data,
    parts,
    input: decode(parts["xl/worksheets/sheet1.xml"]),
    main: decode(parts["xl/worksheets/sheet3.xml"]),
    appendix: decode(parts["xl/worksheets/sheet4.xml"]),
  };
}

const cell = (xml: string, ref: string) =>
  new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(xml)?.[0] ?? "";

describe("buildReportXlsx", () => {
  it("触るのは3シートだけで、他のパーツは元のバイト列のまま", () => {
    const original = unzipSync(template);
    const { parts } = build(["壁のひび"]);
    expect(Object.keys(parts)).toEqual(Object.keys(original));
    const changed = ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet3.xml", "xl/worksheets/sheet4.xml"];
    for (const name of Object.keys(original)) {
      if (changed.includes(name)) continue;
      expect(Buffer.from(parts[name]).equals(Buffer.from(original[name])), name).toBe(true);
    }
  });

  it("入力シートに値を inlineStr で入れ、スタイルは保つ", () => {
    const { input } = build(["壁のひび"]);
    // s= (スタイル) はテンプレートのまま保つ
    expect(cell(input, "C4")).toBe(
      '<c r="C4" s="16" t="inlineStr"><is><t xml:space="preserve">2101230101</t></is></c>',
    );
    expect(cell(input, "C6")).toContain("山田　太郎（ヤマダ　タロウ）");
    expect(cell(input, "C13")).toContain("木村美恵子");
    expect(cell(input, "C9")).toContain("080-1234-5678");
    expect(cell(input, "C10")).toContain("090-2345-6789");
  });

  it("受付者を差し替えると入力シートと本紙のキャッシュ値も変わる", () => {
    const { input, main } = build(["壁のひび"], {
      ...DEFAULT_REPORT_OPTIONS,
      receptionist: "架空　花子",
    });
    expect(cell(input, "C13")).toContain("架空　花子");
    expect(cell(main, "M13")).toContain("<v>架空　花子</v>");
  });

  it("本紙は数式を残してキャッシュ値だけ書き換える", () => {
    const { main } = build(["壁のひび"]);
    const d7 = cell(main, "D7");
    expect(d7).toContain('<f>IF(入力シート!C6="","",入力シート!C6)</f>');
    expect(d7).toContain("<v>山田　太郎（ヤマダ　タロウ）</v>");
    expect(d7).toContain('t="str"');
    // 「様」は表示形式が付けるので値には含めない
    expect(d7).not.toContain("様</v>");
  });

  it("5件までは本紙に №+本文 が入り、作業内容側の№も揃う", () => {
    const { main, input } = build(["壁のひび", "床のきしみ"]);
    expect(cell(main, "B16")).toContain("<v>①</v>");
    expect(cell(main, "C16")).toContain("<v>壁のひび</v>");
    // 作業内容の№は項目ごとに1行ずつ (数式ではなく値で入れる)
    expect(cell(main, "B23")).toContain("<t xml:space=\"preserve\">①</t>");
    expect(cell(main, "B24")).toContain("<t xml:space=\"preserve\">②</t>");
    // 3件目以降は空 (<v/>)
    expect(cell(main, "C18")).toContain("<v/>");
    expect(cell(input, "B19")).toBe('<c r="B19" s="15"/>');
  });

  it("6件以上は本紙が「別紙参照」だけになり、別紙に全件入る", () => {
    const items = ["壁のひび", "床のきしみ", "建具の調整", "外壁の汚れ", "雨樋の詰まり", "天井の凹凸"];
    const { main, input, appendix } = build(items);
    expect(cell(input, "C17")).toContain("別紙参照");
    // 「別紙参照」に№は付けない
    expect(cell(input, "B17")).toBe('<c r="B17" s="15"/>');
    expect(cell(main, "C16")).toContain("<v>別紙参照</v>");
    expect(cell(main, "B16")).toContain("<v/>");
    // 別紙に回したときは作業内容にも番号を出さない
    expect(cell(main, "B23")).toBe('<c r="B23" s="8"/>');
    expect(cell(appendix, "A4")).toContain("1年目点検是正項目");
    expect(cell(appendix, "A2")).toContain("物件名：653.架空町7-21-12A号棟");
    expect(cell(appendix, "A3")).toContain("施主名：山田 太郎様");
    items.forEach((text, k) => {
      expect(cell(appendix, `A${6 + 2 * k}`)).toContain(`${"①②③④⑤⑥"[k]}${text}`);
      expect(cell(appendix, `A${7 + 2 * k}`)).toContain("対応結果：");
    });
    // 項目が無い対の「対応結果：」は消す (見本の別紙と同じ)
    expect(cell(appendix, "A19")).toBe('<c r="A19" s="42"/>');
  });

  it("別紙を使わないときは項目行と対応結果を空にする", () => {
    const { appendix } = build(["壁のひび"]);
    expect(cell(appendix, "A4")).toBe('<c r="A4" s="38"/>');
    for (let k = 0; k < 12; k++) {
      expect(cell(appendix, `A${6 + 2 * k}`)).not.toContain("<t");
      expect(cell(appendix, `A${7 + 2 * k}`)).not.toContain("<t");
    }
  });

  it("チェックボックスは真偽値セルの値だけを変える (既定は点検のみ)", () => {
    const { main } = build(["壁のひび"]);
    expect(cell(main, "D12")).toBe('<c r="D12" s="52" t="b"><v>1</v></c>');
    for (const ref of ["D11", "G11", "K11", "G12", "K12", "N12", "Q12"]) {
      expect(cell(main, ref), ref).toContain("<v>0</v>");
    }
    const custom = {
      attendance: { owner: true, family: false, other: true },
      categories: { inspection: false, after: true, paid: false, direct: false, free: true },
    };
    const withCustom = build(["壁のひび"], custom).main;
    expect(cell(withCustom, "D11")).toContain("<v>1</v>");
    expect(cell(withCustom, "K11")).toContain("<v>1</v>");
    expect(cell(withCustom, "D12")).toContain("<v>0</v>");
    expect(cell(withCustom, "G12")).toContain("<v>1</v>");
    expect(cell(withCustom, "Q12")).toContain("<v>1</v>");
    // 完了チェックは常に未チェックのまま
    expect(cell(withCustom, "T23")).toContain("<v>0</v>");
  });

  it("13件以上でもExcelは12件まで入れて壊れない", () => {
    const items = Array.from({ length: 14 }, (_, i) => `項目${i + 1}`);
    const { appendix, data } = build(items);
    expect(data.warnings.some((w) => w.includes("12件まで"))).toBe(true);
    expect(cell(appendix, "A28")).toContain("⑫項目12");
    expect(appendix).not.toContain("項目13");
  });

  it("XMLの特殊文字を含む値でも壊れない", () => {
    const { input, appendix } = build(["A&B<C>D の「隙間」あり", "b", "c", "d", "e", "f"]);
    expect(cell(appendix, "A6")).toContain("①A&amp;B&lt;C&gt;D の「隙間」あり");
    expect(() => new DOMParser().parseFromString(input, "text/xml")).not.toThrow();
  });

  it("書き換えた3シートは整形式のXMLのまま", () => {
    const { input, main, appendix } = build([
      "壁のひび",
      "補足: 3階北側",
      "床のきしみ",
      "a",
      "b",
      "c",
      "d",
    ]);
    for (const xml of [input, main, appendix]) {
      const errors: string[] = [];
      const doc = new DOMParser({
        onError: (_level: string, msg: string) => errors.push(msg),
      } as never).parseFromString(xml, "text/xml");
      expect(errors).toEqual([]);
      expect(doc.getElementsByTagName("sheetData").length).toBe(1);
    }
  });

  it("★1行に入らない項目は次の枠に続きが入り、続きの№は空", () => {
    const long =
      "基礎の巾木仕上げ施工時に土台水切りや通気パッキン周辺の通気スリットまで塗り込まれて隙間が閉塞・阻害されている状況";
    const { input, main } = build([long]);
    expect(cell(input, "C17")).toContain("塗り込まれて");
    expect(cell(input, "C18")).toContain("隙間が閉塞・阻害されている状況");
    expect(cell(input, "B17")).toContain("①");
    // 続きの行に№は入れない (本紙・作業内容欄とも)
    expect(cell(input, "B18")).toBe('<c r="B18" s="15"/>');
    expect(cell(main, "C17")).toContain("<v>隙間が閉塞・阻害されている状況</v>");
    expect(cell(main, "B17")).toContain("<v/>");
    // ★作業内容・是正内容は続きの行で広げない (①は1行だけ)
    expect(cell(main, "B23")).toContain("<t xml:space=\"preserve\">①</t>");
    expect(cell(main, "B24")).toBe('<c r="B24" s="8"/>');
  });

  it("★作業内容の№は項目ごとに1行ずつ (続き・補足があっても詰めて並べる)", () => {
    const long =
      "基礎の巾木仕上げ施工時に土台水切りや通気パッキン周辺の通気スリットまで塗り込まれて隙間が閉塞・阻害されている状況";
    const { main } = build([long, "補足: 通気スリットの清掃も必要", "建具の調整"]);
    // 指示内容は ①・続き・補足・② の4行
    expect(cell(main, "B16")).toContain("<v>①</v>");
    expect(cell(main, "B19")).toContain("<v>②</v>");
    // 作業内容は ①② が続けて並ぶ
    expect(cell(main, "B23")).toContain("<t xml:space=\"preserve\">①</t>");
    expect(cell(main, "B24")).toContain("<t xml:space=\"preserve\">②</t>");
    expect(cell(main, "B25")).toBe('<c r="B25" s="8"/>');
  });

  it("★別紙は補足のある項目だけ、項目行の下に細い欄を作る", () => {
    const { appendix, parts } = build([
      "①壁のひび",
      "②床のきしみ",
      "補足: 2階のみ",
      "③建具の調整",
      "④外壁の汚れ",
      "⑤雨樋の詰まり",
      "⑥天井の凹凸",
    ]);
    // 1枠目 (補足なし): 項目行6・対応結果行7
    expect(cell(appendix, "A6")).toContain("①壁のひび");
    expect(cell(appendix, "A7")).toContain("対応結果：");
    // 2枠目 (補足あり): 項目行8・補足の細い欄9・対応結果行10
    expect(cell(appendix, "A8")).toContain("②床のきしみ");
    expect(cell(appendix, "A9")).toContain("・2階のみ");
    expect(appendix).toContain('<row r="9" spans="1:2" ht="15" customHeight="1">');
    expect(cell(appendix, "A10")).toContain("対応結果：");
    // 3枠目は1行ずれる
    expect(cell(appendix, "A11")).toContain("③建具の調整");
    // チェック欄の結合は枠の全部の行にまたがる
    expect(appendix).toContain('<mergeCell ref="B6:B7"/>');
    expect(appendix).toContain('<mergeCell ref="B8:B10"/>');
    // 使う範囲・印刷範囲・書式も行数に合わせる
    const lastRow = 28;
    expect(appendix).toContain(`<dimension ref="A1:B${lastRow}"/>`);
    expect(decode(parts["xl/workbook.xml"])).toContain(`別紙!$A$1:$B$${lastRow}`);
    const styles = decode(parts["xl/styles.xml"]);
    expect(styles).toContain('borderId="35" xfId="2" applyBorder="1" applyAlignment="1">');
    const count = /<cellXfs count="(\d+)">/.exec(styles)?.[1];
    expect(Number(count)).toBe(142);
  });

  it("補足が無ければ書式と印刷範囲はテンプレートのまま", () => {
    const original = unzipSync(template);
    const { parts } = build(["a", "b", "c", "d", "e", "f"]);
    for (const name of ["xl/styles.xml", "xl/workbook.xml"]) {
      expect(Buffer.from(parts[name]).equals(Buffer.from(original[name])), name).toBe(true);
    }
  });

  it("テンプレートのパーツが欠けていたら例外", () => {
    const broken = unzipSync(template);
    delete broken["xl/worksheets/sheet3.xml"];
    const data = buildReportData(source(["壁のひび"]), DEFAULT_REPORT_OPTIONS);
    expect(() => buildReportXlsx(zipSync(broken), data)).toThrow(ReportTemplateError);
    expect(() => buildReportXlsx(new Uint8Array([1, 2, 3]), data)).toThrow(ReportTemplateError);
  });
});

describe("sheet-xml", () => {
  const xml = '<sheetData><row r="1"><c r="A1" s="3"/><c r="B1" s="4" t="b"><v>0</v></c>' +
    '<c r="C1" s="5" t="str"><f>IF(x)</f><v>old</v></c></row></sheetData>';

  it("空文字を書くと値のない空セルに戻る", () => {
    expect(setInlineString(xml, "A1", "")).toContain('<c r="A1" s="3"/>');
    expect(setFormulaCache(xml, "C1", "")).toContain('<c r="C1" s="5" t="str"><f>IF(x)</f><v/></c>');
  });

  it("対象セルが無い・種類が違うときは例外", () => {
    expect(() => setInlineString(xml, "Z9", "x")).toThrow(ReportTemplateError);
    expect(() => setBoolean(xml, "A1", true)).toThrow(ReportTemplateError);
    expect(() => setFormulaCache(xml, "A1", "x")).toThrow(ReportTemplateError);
  });
});
