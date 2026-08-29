import { describe, expect, it } from "vitest";
import {
  APPENDIX_REFERENCE_TEXT,
  DEFAULT_REPORT_OPTIONS,
  RECEPTIONIST,
  appendixTitle,
  buildOwnerLine,
  buildReportData,
  normalizeReportOptions,
  splitInstructionItems,
  type ReportSource,
} from "@/lib/report/model";
import { NO_DEFECT_TEXT } from "@/lib/summarize/format";
import { COLUMNS, ADDRESS_COL, HANDOVER_COL, OWNER_COL, PJ_COL, PROPERTY_COL, RECEPTION_DATE_COL, RECEPTION_TYPE_COL, SUMMARY_COL } from "@/lib/tsv";
import type { Contact } from "@/lib/types";

/** 架空データ (個人情報は入れない) */
function source(over: Partial<Record<number, string>> = {}, mail?: Partial<ReportSource["mail"]>): ReportSource {
  const cells = COLUMNS.map(() => "");
  cells[PJ_COL] = "2101230101";
  cells[RECEPTION_TYPE_COL] = "1年";
  cells[RECEPTION_DATE_COL] = "2026/7/22";
  cells[PROPERTY_COL] = "653.架空町7-21-12A号棟";
  cells[OWNER_COL] = "山田　太郎";
  cells[ADDRESS_COL] = "東京都架空町7-21-11";
  cells[HANDOVER_COL] = "2025/9/26";
  cells[SUMMARY_COL] = "1階洋室壁のクロスにのり汚れ";
  for (const [k, v] of Object.entries(over)) cells[Number(k)] = v ?? "";
  return {
    cells,
    mail: { ownerKana: "ヤマダ　タロウ", contacts: [], ...mail },
  };
}

const phone = (p: string, relation = ""): Contact => ({ phone: p, relation, confidence: "ok" });

describe("splitInstructionItems", () => {
  it("丸数字と番号付きの先頭を落とす", () => {
    expect(splitInstructionItems("①壁のひび\n②床のきしみ")).toEqual(["壁のひび", "床のきしみ"]);
    expect(splitInstructionItems("(21)21件目\n1.番号付き\n・中黒")).toEqual([
      "21件目",
      "番号付き",
      "中黒",
    ]);
  });

  it("メモ行と「指摘なし」の定型文は落とす", () => {
    expect(splitInstructionItems(`①壁のひび\nメモ: 次回訪問時に確認\n${NO_DEFECT_TEXT}`)).toEqual([
      "壁のひび",
    ]);
    expect(splitInstructionItems(NO_DEFECT_TEXT)).toEqual([]);
  });

  it("CRLF・空行・前後の空白を吸収する", () => {
    expect(splitInstructionItems("  ①壁のひび \r\n\r\n②床のきしみ\r\n")).toEqual([
      "壁のひび",
      "床のきしみ",
    ]);
  });

  it("番号が付いていない1件はそのまま", () => {
    expect(splitInstructionItems("1階洋室壁のクロスにのり汚れ")).toEqual([
      "1階洋室壁のクロスにのり汚れ",
    ]);
  });
});

describe("appendixTitle", () => {
  it("受付種別から別紙のタイトルを作る", () => {
    expect(appendixTitle("1年")).toBe("1年目点検是正項目");
    expect(appendixTitle("3ヶ月")).toBe("3ヶ月目点検是正項目");
    expect(appendixTitle("")).toBe("点検是正項目");
  });
});

describe("buildOwnerLine", () => {
  it("カナがあれば括弧で添える (姓名間は全角スペース)", () => {
    expect(buildOwnerLine("山田 太郎", "ヤマダ タロウ")).toBe("山田　太郎（ヤマダ　タロウ）");
  });

  it("カナが無ければ括弧ごと省く。「様」は付けない (Excelの表示形式が付ける)", () => {
    expect(buildOwnerLine("山田　太郎", "")).toBe("山田　太郎");
    expect(buildOwnerLine("", "ヤマダ")).toBe("");
  });
});

describe("buildReportData", () => {
  it("セルとカナ・連絡先から各欄を埋める", () => {
    const d = buildReportData(
      source({}, { contacts: [phone("080-1234-5678", "ご主人"), phone("090-2345-6789", "奥様")] }),
      DEFAULT_REPORT_OPTIONS,
    );
    expect(d.pj).toBe("2101230101");
    expect(d.receptionDate).toBe("2026/7/22");
    expect(d.handoverDate).toBe("2025/9/26");
    expect(d.propertyName).toBe("653.架空町7-21-12A号棟");
    expect(d.ownerLine).toBe("山田　太郎（ヤマダ　タロウ）");
    expect(d.address).toBe("東京都架空町7-21-11");
    // 連絡先は番号だけ (続柄は完了報告書には載せない)
    expect([d.phone1, d.phone2]).toEqual(["080-1234-5678", "090-2345-6789"]);
    expect(d.receptionist).toBe(RECEPTIONIST);
    expect(d.useAppendix).toBe(false);
    expect(d.appendix).toBeNull();
  });

  it("連絡先が0件・1件でも落ちない", () => {
    expect(buildReportData(source(), DEFAULT_REPORT_OPTIONS)).toMatchObject({ phone1: "", phone2: "" });
    expect(
      buildReportData(source({}, { contacts: [phone("03-1234-5678")] }), DEFAULT_REPORT_OPTIONS),
    ).toMatchObject({ phone1: "03-1234-5678", phone2: "" });
  });

  it("5件までは本紙に №+本文 を並べる", () => {
    const summary = ["壁のひび", "床のきしみ", "建具の調整", "外壁の汚れ", "雨樋の詰まり"]
      .map((s, i) => `${"①②③④⑤"[i]}${s}`)
      .join("\n");
    const d = buildReportData(source({ [SUMMARY_COL]: summary }), DEFAULT_REPORT_OPTIONS);
    expect(d.useAppendix).toBe(false);
    expect(d.main).toEqual([
      { no: "①", text: "壁のひび" },
      { no: "②", text: "床のきしみ" },
      { no: "③", text: "建具の調整" },
      { no: "④", text: "外壁の汚れ" },
      { no: "⑤", text: "雨樋の詰まり" },
    ]);
  });

  it("6件以上は本紙を「別紙参照」1行にして別紙へ全件回す", () => {
    const items = ["壁のひび", "床のきしみ", "建具の調整", "外壁の汚れ", "雨樋の詰まり", "天井の凹凸"];
    const d = buildReportData(
      source({ [SUMMARY_COL]: items.map((s, i) => `${"①②③④⑤⑥"[i]}${s}`).join("\n") }),
      DEFAULT_REPORT_OPTIONS,
    );
    expect(d.useAppendix).toBe(true);
    // 「別紙参照」には№を付けない
    expect(d.main[0]).toEqual({ no: "", text: APPENDIX_REFERENCE_TEXT });
    expect(d.main.slice(1)).toEqual(Array(4).fill({ no: "", text: "" }));
    expect(d.appendix).toEqual({
      title: "1年目点検是正項目",
      propertyLine: "物件名：653.架空町7-21-12A号棟",
      // 別紙は漢字のみ・半角スペース・様を直結
      ownerLine: "施主名：山田 太郎様",
      items: items.map((s, i) => `${"①②③④⑤⑥"[i]}${s}`),
    });
  });

  it("13件以上はExcelの別紙に入らないことを警告する", () => {
    const summary = Array.from({ length: 13 }, (_, i) => `項目${i + 1}`).join("\n");
    const d = buildReportData(source({ [SUMMARY_COL]: summary }), DEFAULT_REPORT_OPTIONS);
    expect(d.items).toHaveLength(13);
    expect(d.appendix?.items).toHaveLength(13);
    expect(d.warnings.some((w) => w.includes("12件まで"))).toBe(true);
  });

  it("指示内容が空・カナ無しは警告する", () => {
    const d = buildReportData(
      source({ [SUMMARY_COL]: NO_DEFECT_TEXT }, { ownerKana: "" }),
      DEFAULT_REPORT_OPTIONS,
    );
    expect(d.items).toEqual([]);
    expect(d.main.every((m) => m.text === "")).toBe(true);
    expect(d.ownerLine).toBe("山田　太郎");
    expect(d.warnings).toHaveLength(2);
  });

  it("受付種別が空でも別紙のタイトルを作れる", () => {
    const summary = Array.from({ length: 6 }, (_, i) => `項目${i + 1}`).join("\n");
    const d = buildReportData(
      source({ [RECEPTION_TYPE_COL]: "", [SUMMARY_COL]: summary }),
      DEFAULT_REPORT_OPTIONS,
    );
    expect(d.appendix?.title).toBe("点検是正項目");
  });
});

describe("normalizeReportOptions", () => {
  it("欠けている値は既定 (点検のみチェック) で埋める", () => {
    expect(normalizeReportOptions(undefined)).toEqual(DEFAULT_REPORT_OPTIONS);
    expect(normalizeReportOptions({ categories: { after: true } })).toEqual({
      attendance: { owner: false, family: false, other: false },
      categories: { inspection: true, after: true, paid: false, direct: false, free: false },
    });
  });

  it("想定外の型は無視する", () => {
    expect(normalizeReportOptions({ attendance: "yes", categories: { inspection: 1 } })).toEqual(
      DEFAULT_REPORT_OPTIONS,
    );
  });
});
