import { describe, expect, it } from "vitest";
import type { SheetTable } from "@/lib/after/xlsx-read";
import { SheetFormatError, dateOf, groupCases, readEndSheet, readProgressSheet, serialOf, toSerial } from "@/lib/shishutsu/sheets";

// 進捗管理表・エンド立会管理表の読み取り。見出しの形は実物（2026.4～アフター進捗管理表）に合わせた。値はすべて架空

const AUG1 = serialOf(2026, 8, 1);

/** 実物と同じ並びの見出し（4〜5行目）。データは6行目から */
function progressSheet(rows: (string | number)[][], name = "7期～"): SheetTable {
  const header = ["区分", "物件数", "PJ", "受付種別", "受付日", "受付者", "担当", "事業者\n・\nEU", "物件名称", "お客様氏名", "住所", "引渡日", "新築時", "", "初回訪問日", "前回\n対応日", "対応\n予定日", "完了日", "完了報告書\n取得日", "工事区分", "アフター受付内容", "手配業者", "対応内容", "", "備考欄"];
  const sub = ["", "", "", "", "", "", "", "", "", "", "", "", "監督", "営業", "", "", "", "", "", "", "", "", "処　　置", "最終更新日", ""];
  const blank = Array(header.length).fill("");
  return { name, rows: [blank, ["アフター対応進捗管理表（架空）", ...blank.slice(1)], blank, header, sub, ...rows.map((r) => r.map(String))] };
}

/** 行（必要な列だけ）。並びは上の見出しどおり */
function row(v: { star?: boolean; pj?: string; type?: string; received?: number; staff?: string; name?: string; handover?: number | ""; completed?: number | ""; work?: string; content?: string; vendor?: string; action?: string }) {
  const r: (string | number)[] = Array(25).fill("");
  r[1] = v.star === false ? "" : "★";
  r[2] = v.pj ?? "99-1-1";
  r[3] = v.type ?? "リロ";
  r[4] = v.received ?? AUG1;
  r[6] = v.staff ?? "架空";
  r[8] = v.name ?? "架空邸";
  r[11] = v.handover ?? "";
  r[17] = v.completed ?? "";
  r[19] = v.work ?? "";
  r[20] = v.content ?? "";
  r[21] = v.vendor ?? "";
  r[22] = v.action ?? "";
  return r;
}

describe("日付", () => {
  it("シリアル値と「2026/8/1」を同じに読む", () => {
    expect(toSerial(String(AUG1))).toBe(AUG1);
    expect(toSerial("2026/8/1")).toBe(AUG1);
    expect(toSerial("2026-08-01")).toBe(AUG1);
    expect(dateOf(AUG1)).toEqual([2026, 8, 1]);
    expect(toSerial("未定")).toBeNull();
    expect(toSerial("")).toBeNull();
  });
});

describe("進捗管理表を読む", () => {
  it("★見出しの文字で列を探す（2段の見出しの「処置」「最終更新日」も）", () => {
    const rows = readProgressSheet([progressSheet([row({ pj: "1234-1", staff: "架空課長", completed: AUG1 + 3, content: "架空の受付", action: "電話で説明" })])], "after", "アフター");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pjText: "1234-1", staff: "架空課長", completedAt: AUG1 + 3, content: "架空の受付", action: "電話で説明", rowNo: 6, star: true });
    expect(rows[0].pj).toEqual({ division: 1, pj: 1234, site: 1, branch: null });
  });

  it("★非表示のシートは読まない", () => {
    const hidden = { ...progressSheet([row({ name: "隠れた行" })], "古い期"), hidden: true };
    const rows = readProgressSheet([hidden, progressSheet([row({ name: "見える行" })])], "after", "アフター");
    expect(rows.map((r) => r.propertyName)).toEqual(["見える行"]);
  });

  it("見出しが無ければ、どのファイルかを確かめてもらう", () => {
    expect(() => readProgressSheet([{ name: "S", rows: [["a", "b"]] }], "after", "アフター進捗管理表")).toThrow(SheetFormatError);
  });

  it("★★の無い行は、直前の★の行と同じ受付（完了日はいちばん遅い日）", () => {
    const rows = readProgressSheet(
      [progressSheet([
        row({ pj: "1234-3", completed: AUG1 + 10 }),
        row({ star: false, pj: "1234-3", completed: AUG1 + 12 }),
        row({ pj: "5678-1", completed: AUG1 + 1 }),
      ])],
      "after",
      "アフター",
    );
    const cases = groupCases(rows);
    expect(cases.map((c) => c.rows.length)).toEqual([2, 1]);
    expect(cases[0].completedAt).toBe(AUG1 + 12);
  });
});

describe("エンド立会管理表を読む", () => {
  const header = ["区分", "PJ", "内覧会日", "担当", "事業者\n・\nEU", "営業（立会）", "物件名称", "住所", "決済日", "新築時", "", "再クリ\n実施日", "", "", "", "", "", "事前確認", "", "備考欄", "最終確認", "", "最終更新日"];
  const sub = ["", "", "", "", "", "", "", "", "", "監督", "営業", "", "", "", "", "", "", "日時", "担当", "", "担当", "日時", ""];
  const data = (staff: string, finalStaff: string) => {
    const r = Array(header.length).fill("");
    r[1] = "99-138-2";
    r[2] = String(AUG1 + 6);
    r[3] = staff;
    r[6] = "架空の号棟";
    r[8] = String(AUG1 + 27);
    r[20] = finalStaff;
    return r;
  };
  const blank = Array(header.length).fill("");

  it("★「最終確認」の下の「担当」を担当にする（内覧会日・決済日も読む）", () => {
    const rows = readEndSheet([{ name: "8期（集計）", rows: [blank, blank, blank, header, sub, data("架空A", "架空B")] }]);
    expect(rows).toEqual([
      { rowNo: 6, pjText: "99-138-2", pj: { division: 99, pj: 138, site: 2, branch: null }, previewAt: AUG1 + 6, settledAt: AUG1 + 27, staff: "架空B", propertyName: "架空の号棟" },
    ]);
  });

  it("★「最終確認」の見出しが無いシート（参照式だけの集計・前の期）は使わない", () => {
    const other = header.map((h) => (h === "最終確認" ? "完了日" : h));
    expect(() => readEndSheet([{ name: "作業集計", rows: [blank, blank, blank, other, sub, data("架空A", "")] }])).toThrow(SheetFormatError);
  });
});
