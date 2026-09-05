import { describe, expect, it } from "vitest";
import { createAfterCase } from "@/lib/after/case";
import { effectiveFields } from "@/lib/after/customer";
import { AFTER_HIDDEN_COLUMNS, DEFAULT_RECEPTIONIST, RECEPTIONISTS, RECEPTION_TYPES } from "@/lib/after/reception";
import type { Customer, CustomerFields } from "@/lib/after/types";
import { buildMailText } from "@/lib/email";
import { AFTER_APPENDIX_TITLE, AFTER_REPORT_OPTIONS, buildReportData } from "@/lib/report/model";
import { dropColumns, expandResultRow, expandRow } from "@/lib/rows";
import {
  ADDRESS_COL,
  COLUMNS,
  DEVELOPER_COL,
  HANDOVER_COL,
  LAST_UPDATED_COL,
  OWNER_COL,
  PJ_COL,
  PROPERTY_COL,
  PROPERTY_COUNT_COL,
  PROPERTY_COUNT_MARK,
  RECEPTIONIST_COL,
  RECEPTION_DATE_COL,
  RECEPTION_TYPE_COL,
  REMARKS_COL,
  SUMMARY_COL,
} from "@/lib/tsv";

const NOW = new Date("2026-08-30T02:00:00Z"); // JST 2026/8/30 11:00

const fields = (over: Partial<CustomerFields> = {}): CustomerFields => ({
  pj: "2101230101",
  developer: "タカマツハウス",
  propertyName: "架空台1丁目 A号棟",
  ownerName: "山田　太郎",
  ownerKana: "ヤマダ　タロウ",
  postalCode: "",
  address: "東京都架空区北町1-2-3",
  contacts: [
    { phone: "090-0000-1234", relation: "", confidence: "ok" },
    { phone: "03-0000-5678", relation: "奥様", confidence: "ok" },
  ],
  emails: [],
  handoverDate: "2025/09/26",
  supervisor: "",
  salesRep: "",
  memo: "",
  ...over,
});

const customer = (over: Partial<CustomerFields> = {}, corporate = false): Customer => ({
  id: "dx:2101230101",
  source: "dx",
  sourceKey: "2101230101",
  sourceRow: 3,
  imported: fields(over),
  edits: {},
  issues: [],
  corporate,
  searchKey: "",
  importedAt: 0,
  editedAt: null,
});

const build = (over: Partial<CustomerFields> = {}, summary = "浴室の換気扇から異音") =>
  createAfterCase({
    id: "c-1",
    customer: customer(over),
    inquiryText: "換気扇から異音がする",
    summary,
    engine: "gemini",
    now: NOW,
  });

describe("createAfterCase", () => {
  it("顧客データから24列を埋める", () => {
    const row = build();
    expect(row.cells).toHaveLength(COLUMNS.length);
    expect(row.cells[PJ_COL]).toBe("2101230101");
    expect(row.cells[DEVELOPER_COL]).toBe("タカマツハウス");
    expect(row.cells[PROPERTY_COL]).toBe("架空台1丁目 A号棟");
    expect(row.cells[OWNER_COL]).toBe("山田　太郎");
    expect(row.cells[ADDRESS_COL]).toBe("東京都架空区北町1-2-3");
    expect(row.cells[SUMMARY_COL]).toBe("浴室の換気扇から異音");
  });

  it("受付日は今日 (日本時間・ゼロ埋めなし)、最終更新日も今日", () => {
    const row = build();
    expect(row.cells[RECEPTION_DATE_COL]).toBe("2026/8/30");
    expect(row.cells[LAST_UPDATED_COL]).toBe("8月30日");
  });

  it("引渡日はゼロ埋め表記のまま入る", () => {
    expect(build().cells[HANDOVER_COL]).toBe("2025/09/26");
  });

  it("受付種別は未選択 (要確認)、受付者は既定の木村", () => {
    const row = build();
    expect(row.cells[RECEPTION_TYPE_COL]).toBe("");
    expect(row.confidences[RECEPTION_TYPE_COL]).toBe("warn");
    expect(row.cells[RECEPTIONIST_COL]).toBe(DEFAULT_RECEPTIONIST);
    expect(RECEPTIONISTS).toContain(DEFAULT_RECEPTIONIST);
  });

  it("備考欄は空 (定期点検専用の欄)", () => {
    expect(build().cells[REMARKS_COL]).toBe("");
  });

  it("メール文用にカナと連絡先を持つ", () => {
    const row = build();
    expect(row.mail.ownerKana).toBe("ヤマダ　タロウ");
    expect(row.mail.kanaConfidence).toBe("ok");
    expect(row.mail.contacts).toHaveLength(2);
  });

  it("完了報告書はアフターの既定 (アフター☑) になる", () => {
    const row = build();
    expect(row.kind).toBe("after");
    expect(row.report).toEqual(AFTER_REPORT_OPTIONS);
  });

  it("PJ・事業者・引渡日が無ければ注意を出す", () => {
    const row = build({ pj: null, developer: null, handoverDate: null });
    expect(row.confidences[PJ_COL]).toBe("fail");
    expect(row.confidences[DEVELOPER_COL]).toBe("warn");
    expect(row.warnings.join(" ")).toMatch(/PJ/);
    expect(row.warnings.join(" ")).toMatch(/事業者/);
    expect(row.warnings.join(" ")).toMatch(/引渡日/);
  });

  it("要約が取れなければ要確認にする", () => {
    const row = createAfterCase({
      id: "c-2",
      customer: customer(),
      inquiryText: "…",
      summary: "",
      engine: "rule",
      summaryFailed: true,
      now: NOW,
    });
    expect(row.confidences[SUMMARY_COL]).toBe("fail");
  });

  it("法人名は空白をそのままにする", () => {
    const row = createAfterCase({
      id: "c-3",
      customer: customer({ ownerName: "株式会社 架空建設" }, true),
      inquiryText: "…",
      summary: "外壁の汚れ",
      engine: "gemini",
      now: NOW,
    });
    expect(row.cells[OWNER_COL]).toBe("株式会社 架空建設");
  });

  it("結合PDFは持たない (PDFをDLボタンを出さない)", () => {
    expect(build().merged).toBeNull();
  });
});

describe("物件数の★", () => {
  it("記録1件の印として★が入る", () => {
    expect(build().cells[PROPERTY_COUNT_COL]).toBe(PROPERTY_COUNT_MARK);
  });
});

describe("学習用のフィールド", () => {
  it("伏せ字メモと登録時の要約を持つ", () => {
    const row = createAfterCase({
      id: "c-9",
      customer: customer(),
      inquiryText: "原文のメモ",
      redactedInquiry: "伏せ字のメモ",
      summary: "浴室の換気扇から異音",
      engine: "gemini",
    });
    expect(row.redactedInquiry).toBe("伏せ字のメモ");
    expect(row.originalSummary).toBe("浴室の換気扇から異音");
  });

  it("伏せ字メモを渡さなければ undefined (古い受付と同じ扱い)", () => {
    expect(build().redactedInquiry).toBeUndefined();
  });
});

describe("受付一覧の貼り付け", () => {
  it("備考欄を除いた23列になる", () => {
    const row = build();
    const rows = dropColumns(expandRow(row.cells, []), AFTER_HIDDEN_COLUMNS);
    expect(rows[0]).toHaveLength(COLUMNS.length - 1);
    // 備考欄は末尾なので他の列の位置はずれない
    expect(rows[0][PROPERTY_COUNT_COL]).toBe(PROPERTY_COUNT_MARK);
    expect(rows[0][PJ_COL]).toBe("2101230101");
    expect(rows[0][SUMMARY_COL]).toBe("浴室の換気扇から異音");
  });

  it("工事区分を足すと件数分の行に展開される", () => {
    const row = build();
    const rows = dropColumns(
      expandRow(row.cells, [{ value: "内装" }, { value: "設備" }]),
      AFTER_HIDDEN_COLUMNS,
    );
    expect(rows).toHaveLength(2);
    // 物件数の★は先頭の行だけ (件数が増えないように)
    expect(rows.map((r) => r[PROPERTY_COUNT_COL])).toEqual([PROPERTY_COUNT_MARK, ""]);
  });

  it("工事区分ごとに分けると行ごとに別のアフター受付内容が入る", () => {
    const row = {
      ...build(),
      categories: [
        { value: "換気システム", confidence: "ok" as const, summary: "浴室の換気扇から異音" },
        { value: "サッシ", confidence: "ok" as const, summary: "2階洋室の窓が閉まりにくい" },
      ],
    };
    const rows = dropColumns(expandResultRow(row), AFTER_HIDDEN_COLUMNS);
    expect(rows.map((r) => r[SUMMARY_COL])).toEqual([
      "浴室の換気扇から異音",
      "2階洋室の窓が閉まりにくい",
    ]);
  });

  it("受付種別の選択肢が仕様どおり", () => {
    expect(RECEPTION_TYPES).toContain("リロ");
    expect(RECEPTION_TYPES).toContain("点検再受付");
    expect(RECEPTION_TYPES).toHaveLength(17);
  });
});

describe("メール文・完了報告書との連携", () => {
  it("メール文がそのまま組み立てられる", () => {
    const row = build();
    const text = buildMailText({
      handoverDate: row.cells[HANDOVER_COL],
      propertyName: row.cells[PROPERTY_COL],
      ownerName: row.cells[OWNER_COL],
      ownerKana: row.mail.ownerKana,
      address: row.cells[ADDRESS_COL],
      contacts: row.mail.contacts,
      summary: row.cells[SUMMARY_COL],
    });
    expect(text).toContain("引渡日：2025/09/26");
    expect(text).toContain("施主名：山田　太郎（ヤマダ　タロウ）様");
    expect(text).toContain("連絡先①：090-0000-1234");
    expect(text).toContain("連絡先②：03-0000-5678（奥様）");
  });

  it("完了報告書の別紙タイトルがアフター用になる", () => {
    const row = build({}, ["a", "b", "c", "d", "e", "f"].join("\n"));
    const data = buildReportData(row, row.report);
    expect(data.useAppendix).toBe(true);
    expect(data.appendix?.title).toBe(AFTER_APPENDIX_TITLE);
    expect(data.receptionist).toBe("木村美恵子");
  });
});

describe("effectiveFields", () => {
  it("修正があれば優先する", () => {
    const c = { ...customer(), edits: { developer: "大和ハウス工業" } };
    expect(effectiveFields(c).developer).toBe("大和ハウス工業");
  });
});
