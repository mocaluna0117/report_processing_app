import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readXlsxSheets } from "@/lib/after/xlsx-read";
import { type ExpenseReport, type ReportRow, STAFF_ROSTER } from "@/lib/shishutsu/build";
import { serialOf } from "@/lib/shishutsu/sheets";
import { buildExpenseXlsx } from "@/lib/shishutsu/xlsx";

// 支出報告書の xlsx。テンプレートは public/report/expense-report.xlsx（scripts/build_expense_template.py）。値はすべて架空

const template = new Uint8Array(readFileSync("public/report/expense-report.xlsx"));
const parts = (bytes: Uint8Array) => {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextDecoder().decode(v)]));
};

function row(no: string, cost = 0, extra: Partial<ReportRow> = {}): ReportRow {
  return {
    no,
    handoverAt: serialOf(2018, 4, 1),
    completedAt: serialOf(2026, 8, 3),
    division: 1,
    pj: 9999,
    site: 1,
    branch: null,
    propertyName: `架空邸${no}`,
    category: "A",
    summary: "架空の受付",
    cost,
    staff: "木村",
    note: "",
    estimated: false,
    ...extra,
  };
}

const report: ExpenseReport = {
  year: 2026,
  month: 8,
  title: "2026年　8月度　　アフターメンテナンス課　支出報告書",
  sections: [
    { key: "rizap", label: "RIZAP対象", rows: [row("1-1", 100000, { branch: 55 }), row("1-2", 20000), row("2", 0, { handoverAt: null })], cases: 2 },
    { key: "other", label: "RIZAP対象外", rows: [], cases: 0 },
    { key: "end", label: "エンド立会", rows: [row("1", 15000, { category: "エンド立会" })], cases: 1 },
  ],
  staff: STAFF_ROSTER.map((name) => ({ name, rizap: name === "木村" ? 2 : 0, other: 0, end: name === "松廣" ? 1 : 0 })),
  totalCost: 135000,
  warnings: [],
};

describe("テンプレート", () => {
  it("★お客様の行・共有文字列・作成者名・フォルダーの場所が入っていない", () => {
    const files = parts(template);
    expect(Object.keys(files)).not.toContain("xl/sharedStrings.xml");
    expect(Object.keys(files).filter((n) => n.startsWith("xl/worksheets/sheet"))).toEqual(["xl/worksheets/sheet1.xml"]);
    const sheet = files["xl/worksheets/sheet1.xml"];
    const rowNos = [...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...rowNos)).toBe(18);
    const all = Object.values(files).join("");
    expect(all).not.toMatch(/Users|Box|lastPrinted/);
    expect(files["docProps/core.xml"]).toContain("<dc:creator>Folio</dc:creator>");
  });
});

describe("支出報告書の xlsx を作る", () => {
  const bytes = buildExpenseXlsx(template, report);
  const files = parts(bytes);
  const sheet = files["xl/worksheets/sheet1.xml"];
  const [table] = readXlsxSheets(bytes);
  const at = (ref: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    return table.rows[Number(m[2]) - 1]?.[m[1].charCodeAt(0) - 65] ?? "";
  };

  it("★シート名・タイトル・印刷範囲に月が入る", () => {
    expect(table.name).toBe("8月度支出報告");
    expect(at("A1")).toBe(report.title);
    expect(files["xl/workbook.xml"]).toContain("'8月度支出報告'!$A$1:$Q$26");
    expect(files["xl/workbook.xml"]).toContain("'8月度支出報告'!$17:$18");
    expect(files["docProps/app.xml"]).toContain("<vt:lpstr>8月度支出報告</vt:lpstr>");
  });

  it("★表は RIZAP対象 → 対象外 → エンド の順に、見出し2行＋行（空の表も見出しは出す）", () => {
    // 17-18 見出し / 19-21 RIZAP対象 / 22-23 見出し（対象外は0行）/ 24-25 見出し / 26 エンド立会
    expect(at("A17")).toBe("№");
    expect([at("A19"), at("A20"), at("A21")]).toEqual(["1-1", "1-2", "2"]);
    expect(at("A22")).toBe("№");
    expect(at("A24")).toBe("№");
    expect(at("A26")).toBe("1");
    expect(at("K23")).toBe("その他");
    expect(sheet).toContain('<mergeCell ref="K22:M22"/>');
    expect(sheet).toContain('<mergeCell ref="A24:A25"/>');
    expect(sheet).toContain('<mergeCell ref="P3:Q3"/>');
  });

  it("★日付はシリアル値（書式は見本のまま）・引渡日不明は「不明」・支出金額は数式と結果", () => {
    expect(at("B19")).toBe(String(serialOf(2018, 4, 1)));
    expect(at("C19")).toBe(String(serialOf(2026, 8, 3)));
    expect(at("B21")).toBe("不明");
    expect(at("G19")).toBe("55");
    expect(sheet).toContain('<c r="O19" s="116"><f>(K19+L19+M19)-N19</f><v>-100000</v></c>');
    // 各表の最後の行は下が太線の書式
    expect(sheet).toContain('<c r="A21" s="158"');
    expect(sheet).toContain('<c r="A20" s="52"');
  });

  it("★合計欄と担当者別の件数", () => {
    expect(sheet).toContain('<c r="O4" s="41"><f>SUM(N19:N300)</f><v>135000</v></c>');
    expect(sheet).toContain('<c r="P4" s="128"><f>N4-O4</f><v>-135000</v></c>');
    expect(at("C12")).toBe("2"); // 木村 RIZAP
    expect(at("E10")).toBe("1"); // 松廣 エンド
    expect(sheet).toContain("<f>SUM(C7:C14)</f><v>2</v>");
    expect(sheet).toContain("<f>SUM(G7:G14)</f><v>3</v>");
  });

  it("同じ内容なら同じバイト列", () => {
    expect(buildExpenseXlsx(template, report)).toEqual(bytes);
  });
});
