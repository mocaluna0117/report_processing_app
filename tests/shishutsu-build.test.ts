import { describe, expect, it } from "vitest";
import { buildExpenseReport, channelNote, expenseFileName, firstLine, inspectionCategory, normalizeStaff } from "@/lib/shishutsu/build";
import { parsePj } from "@/lib/shishutsu/pj";
import { type EndRow, type ProgressRow, serialOf } from "@/lib/shishutsu/sheets";
import type { TenmatsuEntry } from "@/lib/shishutsu/tenmatsu";
import { parseYen, toTenmatsuEntries } from "@/lib/shishutsu/tenmatsu";

// 支出報告書の組み立て。決まりは 2026-10-03 に利用者と確認したもの。値はすべて架空

const d = (m: number, day: number, y = 2026) => serialOf(y, m, day);
let seq = 0;

function progress(v: Partial<ProgressRow> & { pjText?: string }): ProgressRow {
  seq += 1;
  return {
    source: "after",
    rowNo: seq,
    star: true,
    pjText: v.pjText ?? "9999-1",
    pj: parsePj(v.pjText ?? "9999-1"),
    receptionType: "リロ",
    receivedAt: d(7, 1),
    staff: "木村",
    developer: "",
    propertyName: "架空邸",
    handoverAt: d(4, 1, 2018),
    completedAt: d(8, 10),
    workCategory: "",
    content: "架空の受付",
    vendor: "",
    action: "",
    updatedAt: null,
    ...v,
  };
}

function tenmatsu(v: Partial<TenmatsuEntry> & { pjText?: string }): TenmatsuEntry {
  return {
    denpyoNo: `TE0000${v.no ?? "1000"}`,
    no: "1000",
    pj: v.pjText ? parsePj(v.pjText) : null,
    propertyName: "架空邸",
    appliedAt: d(7, 20),
    payee: "架空工務店",
    amountExTax: 10000,
    amountInclTax: 11000,
    ...v,
  };
}

const build = (input: { after?: ProgressRow[]; noSite?: ProgressRow[]; inspection?: ProgressRow[] | null; end?: EndRow[]; tenmatsu?: TenmatsuEntry[] }) =>
  buildExpenseReport({
    year: 2026,
    month: 8,
    after: input.after ?? [],
    noSite: input.noSite ?? [],
    inspection: input.inspection === undefined ? [] : input.inspection,
    end: input.end ?? [],
    tenmatsu: input.tenmatsu ?? [],
  });

describe("載せる行と表の分け方", () => {
  it("★完了日がその月の受付だけ。引渡日 2019/5/31 以前は RIZAP対象、後は対象外、不明は RIZAP対象", () => {
    const report = build({
      after: [
        progress({ propertyName: "前", handoverAt: d(5, 31, 2019) }),
        progress({ propertyName: "後", handoverAt: d(6, 1, 2019) }),
        progress({ propertyName: "不明", handoverAt: null }),
        progress({ propertyName: "7月完了", completedAt: d(7, 31) }),
        progress({ propertyName: "未完了", completedAt: null }),
      ],
    });
    expect(report.sections.map((s) => s.rows.map((r) => r.propertyName))).toEqual([["前", "不明"], ["後"], []]);
    expect(report.title).toBe("2026年　8月度　　アフターメンテナンス課　支出報告書");
    expect(report.warnings.some((w) => w.includes("引渡日が空の受付 1件"))).toBe(true);
  });

  it("★現場対応なしは受付日で月を決め、完了日の欄にも受付日。点検の行（1年・2年・3ヶ月）は入れない", () => {
    const report = build({
      noSite: [
        progress({ source: "noSite", propertyName: "電話", receivedAt: d(8, 3), completedAt: null, action: "TEL にて説明し、メールで図面を送付" }),
        progress({ source: "noSite", propertyName: "点検", receptionType: "1年", receivedAt: d(8, 5), completedAt: null }),
        progress({ source: "noSite", propertyName: "7月", receivedAt: d(7, 30), completedAt: null }),
      ],
    });
    const rows = report.sections[0].rows;
    expect(rows.map((r) => r.propertyName)).toEqual(["電話"]);
    expect(rows[0].completedAt).toBe(d(8, 3));
    expect(rows[0].note).toBe("電話・メール・書類送付");
    expect(rows[0].cost).toBe(0);
  });

  it("★エンド立会は内覧会日がその月の行。引渡日の欄＝決済日、担当＝最終確認の担当", () => {
    const end: EndRow[] = [
      { rowNo: 1, pjText: "99-138-2", pj: parsePj("99-138-2"), previewAt: d(8, 7), settledAt: d(8, 28), staff: "松廣", propertyName: "架空E号棟" },
      { rowNo: 2, pjText: "99-137-2", pj: parsePj("99-137-2"), previewAt: d(7, 25), settledAt: d(8, 24), staff: "松廣", propertyName: "架空B号棟" },
    ];
    const report = build({ end });
    expect(report.sections[2].rows).toEqual([
      expect.objectContaining({ no: "1", handoverAt: d(8, 28), completedAt: d(8, 7), division: 99, pj: 138, site: 2, category: "エンド立会", summary: "エンド立会", staff: "松廣" }),
    ]);
    expect(report.staff.find((s) => s.name === "松廣")).toMatchObject({ end: 1 });
  });

  it("年次点検の受付種別は区分 1T / 2T / ３ヶ月、雨漏りの工事区分は「雨漏れ」", () => {
    const report = build({
      inspection: [progress({ source: "inspection", receptionType: "2年" }), progress({ source: "inspection", receptionType: "3ヶ月", completedAt: d(8, 11) })],
      after: [progress({ workCategory: "雨漏り", completedAt: d(8, 12) })],
    });
    expect(report.sections[0].rows.map((r) => r.category)).toEqual(["2T", "３ヶ月", "雨漏れ"]);
    expect(inspectionCategory("1年")).toBe("1T");
  });

  it("年次点検の表を選ばなければ、そのことを注意に出す", () => {
    expect(build({ inspection: null }).warnings.some((w) => w.includes("年次点検進捗管理表を選んでいない"))).toBe(true);
  });
});

describe("顛末書を結ぶ", () => {
  it("★PJ が同じで申請日が受付日以降の顛末書を結び、1本1行で № を枝分けする（原価は税抜）", () => {
    const report = build({
      after: [progress({ pjText: "1234-1", receivedAt: d(4, 13), completedAt: d(8, 1), content: "【受付内容】\n架空の雨漏れ再発\n詳細" })],
      tenmatsu: [
        tenmatsu({ no: "1348", pjText: "1012340155", appliedAt: d(6, 1), amountExTax: 478950, payee: "架空B" }),
        tenmatsu({ no: "1234", pjText: "1012340155", appliedAt: d(5, 1), amountExTax: 100000, payee: "架空A" }),
        tenmatsu({ no: "1000", pjText: "1012340155", appliedAt: d(4, 1) }), // 受付日より前（前の工事）
      ],
    });
    const rows = report.sections[0].rows;
    expect(rows.map((r) => [r.no, r.summary, r.cost, r.branch, r.note])).toEqual([
      ["1-1", "架空の雨漏れ再発（顛末書№1234）", 100000, 55, "架空A"],
      ["1-2", "架空の雨漏れ再発（顛末書№1348）", 478950, 55, "架空B"],
    ]);
    expect(report.totalCost).toBe(578950);
    // ★担当者別の件数は受付1件で1
    expect(report.staff.find((s) => s.name === "木村")?.rizap).toBe(1);
  });

  it("★PJ が無ければ物件名で結ぶ。1本の顛末書は申請日にいちばん近い受付にだけ付く", () => {
    const report = build({
      after: [
        progress({ pjText: "", propertyName: "架空　太郎 様邸", receivedAt: d(6, 1), completedAt: d(8, 5) }),
        progress({ pjText: "", propertyName: "架空 太郎様邸", receivedAt: d(7, 10), completedAt: d(8, 20) }),
      ],
      tenmatsu: [tenmatsu({ propertyName: "架空太郎様邸", appliedAt: d(7, 15) })],
    });
    expect(report.sections[0].rows.map((r) => r.summary)).toEqual(["架空の受付", "架空の受付（顛末書№1000）"]);
  });

  it("★税抜が記録に無い顛末書は税込÷1.1 で概算し、備考と注意に出す", () => {
    const report = build({
      after: [progress({ pjText: "1234-1" })],
      tenmatsu: [tenmatsu({ pjText: "1012340101", amountExTax: null, amountInclTax: 33000 })],
    });
    expect(report.sections[0].rows[0]).toMatchObject({ cost: 30000, estimated: true, note: "架空工務店　※税抜は概算" });
    expect(report.warnings.some((w) => w.includes("税込÷1.1 で概算"))).toBe(true);
  });

  it("現場対応なしの受付には結ばない。どこにも結ばれない最近の顛末書は注意に出す", () => {
    const report = build({
      noSite: [progress({ source: "noSite", pjText: "1234-1", receivedAt: d(8, 2), completedAt: null })],
      tenmatsu: [tenmatsu({ no: "1500", pjText: "1012340101", appliedAt: d(8, 10) })],
    });
    expect(report.sections[0].rows[0].summary).toBe("架空の受付");
    expect(report.warnings.some((w) => w.includes("顛末書№1500"))).toBe(true);
  });
});

describe("担当者別の件数", () => {
  it("★連名は 0.5 ずつ・役職は落とす・名簿に無い名前は注意に出す", () => {
    const report = build({
      after: [progress({ staff: "丸山・岩野課長" }), progress({ staff: "架空さん", completedAt: d(8, 11) })],
    });
    expect(report.staff.find((s) => s.name === "丸山")?.rizap).toBe(0.5);
    expect(report.staff.find((s) => s.name === "岩野")?.rizap).toBe(0.5);
    expect(report.sections[0].rows[0].staff).toBe("丸山・岩野");
    expect(report.warnings.some((w) => w.includes("架空"))).toBe(true);
    expect(normalizeStaff("鈴木（架空）\n松廣")).toEqual(["鈴木", "松廣"]);
  });
});

describe("小さな決まり", () => {
  it("受付内容の1行目（見出しだけの行は飛ばす）", () => {
    expect(firstLine("【受付内容】\n子供部屋の相談\n詳細")).toBe("子供部屋の相談");
    expect(firstLine("【追加受付】\nリビングドア")).toBe("リビングドア");
    expect(firstLine("")).toBe("");
  });
  it("対応の手段（電話・SMS・メール・書類）", () => {
    expect(channelNote("お客様へTELするも不通。SMSにてご連絡")).toBe("電話・SMS対応のみ");
    expect(channelNote("メールにて案内済み")).toBe("メール対応のみ");
    expect(channelNote("社内で共有")).toBe("");
  });
  it("金額の文字列とファイル名", () => {
    expect(parseYen("71,500 円")).toBe(71500);
    expect(parseYen(null)).toBeNull();
    expect(expenseFileName(2026, 8)).toBe("2026年 8月度支出報告　【アフターメンテナンス課】.xlsx");
  });
  it("顛末書の記録を使う形に（保留中は除く・申請日は日付だけ・同じ伝票は最後の記録）", () => {
    const entries = toTenmatsuEntries({
      done: ["TE00001404", "TE00001405"],
      log: [
        { denpyo_no: "TE00001404", file: "顛末書№1404.pdf", at: "2026-07-21T10:00:00", amount: "1 円" },
        { denpyo_no: "TE00001404", file: "顛末書№1404.pdf", at: "2026-07-21T10:00:00", pj: "1099990155", where: "注文受注物件：架空邸 施主名：架空", amount: "33,000 円", amount_ex_tax: "30,000 円", payee: "架空", shinsei_date: "2026/07/20 10:00:00" },
        { denpyo_no: "TE00001405", file: "顛末書№1405.pdf", at: "2026-07-22T10:00:00" },
      ],
      flags: {},
      pending: { TE00001405: { at: "", dir: "", missing: [] } as never },
    });
    expect(entries).toEqual([
      { denpyoNo: "TE00001404", no: "1404", pj: { division: 1, pj: 9999, site: 1, branch: 55 }, propertyName: "架空邸", appliedAt: d(7, 20), payee: "架空", amountExTax: 30000, amountInclTax: 33000 },
    ]);
  });
});
