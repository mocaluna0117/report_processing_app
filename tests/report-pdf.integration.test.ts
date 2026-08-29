import { describe, expect, it } from "vitest";
import { buildReportData, DEFAULT_REPORT_OPTIONS, type ReportSource } from "@/lib/report/model";
import { appendixPageLabel, buildReportPdf, sanitizeText } from "@/lib/report/pdf";
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
import { getTokensFromBytes } from "./helpers/pdf-node";
import { reportFontBytes } from "./helpers/report-fonts";

const fonts = reportFontBytes();

/** 架空データのみ (個人情報は入れない) */
function source(items: string[], owner = "山田　太郎", kana = "ヤマダ　タロウ"): ReportSource {
  const cells = COLUMNS.map(() => "");
  cells[PJ_COL] = "2101230101";
  cells[RECEPTION_TYPE_COL] = "1年";
  cells[RECEPTION_DATE_COL] = "2026/7/22";
  cells[PROPERTY_COL] = "653.架空町7-21-12A号棟";
  cells[OWNER_COL] = owner;
  cells[ADDRESS_COL] = "東京都架空町7-21-11";
  cells[HANDOVER_COL] = "2025/9/26";
  cells[SUMMARY_COL] = items.join("\n");
  return {
    cells,
    mail: { ownerKana: kana, contacts: [{ phone: "080-1234-5678", relation: "", confidence: "ok" }] },
  };
}

async function render(items: string[], owner?: string, kana?: string) {
  const data = buildReportData(source(items, owner, kana), DEFAULT_REPORT_OPTIONS);
  const { bytes, warnings } = await buildReportPdf(data, fonts!);
  // pdfjs はバッファをworkerへ渡して detach するので、コピーを読ませて原本を残す
  const { tokens, pageCount } = await getTokensFromBytes(bytes.slice());
  // pdfjs は空白を落とすことがあるので、比較用に空白を除いた文字列も返す
  const pageText = Array.from({ length: pageCount }, (_, i) =>
    tokens
      .filter((t) => t.page === i + 1)
      .map((t) => t.str)
      .join(""),
  );
  const compact = pageText.map((t) => t.replace(/[\s\u3000]/g, ""));
  return { bytes, warnings, pageCount, pageText, compact, data };
}

describe.skipIf(!fonts)("完了報告書PDF", () => {
  it("5件までは1ページで、値が入る", async () => {
    const { pageCount, compact } = await render(["①1階洋室壁のクロスにのり汚れ"]);
    expect(pageCount).toBe(1);
    const text = compact[0];
    expect(text).toContain("作業報告書");
    expect(text).toContain("2101230101");
    // 施主名は「姓　名（カナ）」＋表示形式の「 様」
    expect(text).toContain("山田太郎（ヤマダタロウ）");
    expect(text).toContain("様");
    expect(text).toContain("2025/9/26");
    expect(text).toContain("木村美恵子");
    expect(text).toContain("①");
    expect(text).toContain("1階洋室壁のクロスにのり汚れ");
    expect(text).not.toContain("別紙参照");
  }, 30_000);

  it("6件以上は本紙が「別紙参照」になり、別紙ページが付く", async () => {
    const items = ["壁のひび", "床のきしみ", "建具の調整", "外壁の汚れ", "雨樋の詰まり", "天井の凹凸"];
    const { pageCount, pageText } = await render(items.map((s, i) => `${"①②③④⑤⑥"[i]}${s}`));
    expect(pageCount).toBe(2);
    expect(pageText[0]).toContain("別紙参照");
    // 本紙には項目本文も№も出さない
    expect(pageText[0]).not.toContain("壁のひび");
    expect(pageText[1]).toContain("2/2");
    expect(pageText[1]).toContain("1年目点検是正項目");
    expect(pageText[1]).toContain("物件名：653.架空町7-21-12A号棟");
    expect(pageText[1].replace(/[\s\u3000]/g, "")).toContain("施主名：山田太郎様");
    items.forEach((s, i) => {
      expect(pageText[1]).toContain(`${"①②③④⑤⑥"[i]}${s}`);
    });
    expect(pageText[1].match(/対応結果/g) ?? []).toHaveLength(6);
  }, 30_000);

  it("13件以上は別紙を複数ページに分ける", async () => {
    const items = Array.from({ length: 13 }, (_, i) => `項目${i + 1}`);
    const { pageCount, pageText, warnings } = await render(items);
    expect(pageCount).toBe(3);
    expect(pageText[1]).toContain("2/3");
    expect(pageText[2]).toContain("3/3");
    expect(pageText[2]).toContain("⑬項目13");
    expect(warnings.some((w) => w.includes("2ページに分けました"))).toBe(true);
  }, 30_000);

  it("フォントに無い文字は〓に置き換えて警告する", async () => {
    // U+2A6B2 はサブセットに含めていない
    const { pageText, warnings } = await render(["\u{2A6B2}の壁にひび"]);
    expect(pageText[0]).toContain("〓");
    expect(warnings.some((w) => w.includes("フォントに無い文字"))).toBe(true);
  }, 30_000);

  it("太字フォントに無い文字の見出しでも〓にならない (受付種別「半年」)", async () => {
    const items = ["壁のひび", "床のきしみ", "建具の調整", "外壁の汚れ", "雨樋の詰まり", "天井の凹凸"];
    const data = buildReportData(
      { ...source(items), cells: source(items).cells.map((c, i) => (i === RECEPTION_TYPE_COL ? "半年" : c)) },
      DEFAULT_REPORT_OPTIONS,
    );
    const { bytes, warnings } = await buildReportPdf(data, fonts!);
    const { tokens } = await getTokensFromBytes(bytes.slice());
    const page2 = tokens
      .filter((t) => t.page === 2)
      .map((t) => t.str)
      .join("");
    expect(page2).toContain("半年目点検是正項目");
    expect(page2).not.toContain("〓");
    expect(warnings.filter((w) => w.includes("フォントに無い文字"))).toHaveLength(0);
  }, 30_000);

  it("指示内容が空でも1ページのPDFになる", async () => {
    const { pageCount, pageText } = await render([]);
    expect(pageCount).toBe(1);
    expect(pageText[0]).toContain("指示内容");
  }, 30_000);

  it("カナが無ければ括弧を付けない", async () => {
    const { compact } = await render(["壁のひび"], "山田　太郎", "");
    expect(compact[0]).toContain("山田太郎");
    expect(compact[0]).toContain("山田太郎様");
    expect(compact[0]).not.toContain("太郎（");
  }, 30_000);

  it("必要な文字だけに絞ったフォントを埋め込み、PDFは小さくなる", async () => {
    const { bytes } = await render(["壁のひび"]);
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    // hb-subset で使う文字だけに絞ってから埋め込むので、数十KBに収まる
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.length).toBeLessThan(300_000);
  }, 30_000);
});

describe("sanitizeText", () => {
  it("制御文字とNBSP・異体字セレクタを落とす", () => {
    expect(sanitizeText("a\u0007b\u00a0c")).toBe("ab c");
    expect(sanitizeText("葛\ufe00城")).toBe("葛城");
  });
});

describe("appendixPageLabel", () => {
  it("別紙1ページなら 2/2、2ページなら 2/3・3/3", () => {
    expect(appendixPageLabel(0, 1)).toBe("2/2");
    expect(appendixPageLabel(0, 2)).toBe("2/3");
    expect(appendixPageLabel(1, 2)).toBe("3/3");
  });
});
