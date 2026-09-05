import { describe, expect, it } from "vitest";
import {
  buildHandoverSync,
  handoverDiff,
  indexCustomers,
  matchCustomerForRow,
  reportPj,
} from "@/lib/after/match-report";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";
import { type CellEntry, buildCells, entry } from "@/lib/cells";
import type { ResultRow } from "@/lib/process";
import { DEFAULT_REPORT_OPTIONS } from "@/lib/report/model";
import { HANDOVER_COL } from "@/lib/tsv";
import type { Confidence } from "@/lib/types";

// 架空データのみ (実在の個人情報は使わない)
const fields = (over: Partial<CustomerFields> = {}): CustomerFields => ({
  pj: null,
  developer: "タカマツハウス",
  propertyName: "架空台1丁目 A号棟",
  ownerName: "架空　太郎",
  ownerKana: "カクウ　タロウ",
  postalCode: "",
  address: "東京都架空区北町1-2-3",
  contacts: [],
  emails: [],
  handoverDate: null,
  supervisor: "",
  salesRep: "",
  memo: "",
  ...over,
});

const customer = (
  id: string,
  source: CustomerSource,
  over: Partial<CustomerFields> = {},
): Customer => ({
  id,
  source,
  sourceKey: id,
  sourceRow: 2,
  imported: fields(over),
  edits: {},
  issues: [],
  corporate: false,
  searchKey: id,
  importedAt: 1,
  editedAt: null,
});

const dx = (pj: string, over: Partial<CustomerFields> = {}) =>
  customer(`dx:${pj}`, "dx", { pj, ...over });
const sk = (id: string, over: Partial<CustomerFields> = {}) =>
  customer(`sk:${id}`, "suketto", over);

const row = (
  over: Partial<Record<string, CellEntry>> = {},
  handoverConfidence: Confidence = "ok",
): ResultRow => {
  const { cells, confidences } = buildCells({
    PJ: entry("2101230101"),
    お客様氏名: entry("架空　太郎"),
    住所: entry("東京都架空区北町1-2-3"),
    物件名称: entry("564.架空区北町1-2-3A号棟"),
    引渡日: entry("2025/09/26"),
    ...over,
  });
  confidences[HANDOVER_COL] = handoverConfidence;
  return {
    pairId: "p-1",
    ownerDisplay: "架空 太郎",
    cells,
    confidences,
    categories: [],
    categoryEngine: "none",
    report: DEFAULT_REPORT_OPTIONS,
    mail: { ownerKana: "", kanaConfidence: "fail", kanaAlternatives: [], contacts: [] },
    warnings: [],
    engine: null,
    merged: null,
    mergedName: "",
    error: null,
  };
};

const match = (r: ResultRow, customers: Customer[]) =>
  matchCustomerForRow(r, indexCustomers(customers));

describe("reportPj", () => {
  it("10桁の数字だけを受け付ける (全角も拾う)", () => {
    expect(reportPj("2101230101")).toBe("2101230101");
    expect(reportPj("２１０１２３０１０１")).toBe("2101230101");
    expect(reportPj("210123")).toBeNull();
    expect(reportPj("")).toBeNull();
  });
});

describe("matchCustomerForRow", () => {
  it("点検保守台帳はPJの一致で確定する (氏名の表記が違っても)", () => {
    const result = match(row(), [dx("2101230101", { ownerName: "架空　太郎（架空　花子）" })]);
    expect(result.confidence).toBe("exact");
    expect(result.customer?.id).toBe("dx:2101230101");
    expect(result.reason).toContain("PJ");
  });

  it("PJが一致しても氏名・住所がどちらも違えば要確認", () => {
    const result = match(row(), [
      dx("2101230101", { ownerName: "別人　次郎", address: "東京都架空区南町9-9-9" }),
    ]);
    expect(result.confidence).toBe("probable");
    expect(result.customer?.id).toBe("dx:2101230101");
  });

  it("助っ人クラウドはPJ＋氏名で確定する", () => {
    const result = match(row(), [sk("a", { pj: "2101230101" })]);
    expect(result.confidence).toBe("exact");
    expect(result.reason).toContain("氏名");
  });

  it("助っ人クラウドはPJと氏名が一致しても住所が違えば要確認 (同姓同名)", () => {
    const result = match(row(), [
      sk("a", { pj: "2101230101", address: "東京都架空区南町9-9-9" }),
    ]);
    expect(result.confidence).toBe("probable");
    expect(result.reason).toContain("住所が違います");
  });

  it("同じPJを氏名で絞っても住所が違えば要確認", () => {
    const result = match(row(), [
      sk("a", { pj: "2101230101", address: "東京都架空区南町9-9-9" }),
      sk("b", { pj: "2101230101", ownerName: "別人　次郎", address: "東京都架空区西町2-2-2" }),
    ]);
    expect(result.customer?.id).toBe("sk:a");
    expect(result.confidence).toBe("probable");
  });

  it("助っ人クラウドでPJしか一致しなければ要確認 (PJが別人と衝突しうる)", () => {
    const result = match(row(), [
      sk("a", { pj: "2101230101", ownerName: "別人　次郎", address: "東京都架空区南町9-9-9" }),
    ]);
    expect(result.confidence).toBe("probable");
    expect(result.reason).toContain("PJのみ一致");
  });

  it("同じPJが複数いても氏名で絞れれば確定する", () => {
    const result = match(row(), [
      sk("a", { pj: "2101230101", ownerName: "別人　次郎" }),
      sk("b", { pj: "2101230101" }),
    ]);
    expect(result.confidence).toBe("exact");
    expect(result.customer?.id).toBe("sk:b");
  });

  it("同じPJで絞れなければ候補を出して決めない", () => {
    const result = match(row(), [
      sk("a", { pj: "2101230101", ownerName: "別人　次郎", address: "東京都架空区南町1-1-1" }),
      sk("b", { pj: "2101230101", ownerName: "他人　三郎", address: "東京都架空区西町2-2-2" }),
    ]);
    expect(result.confidence).toBe("none");
    expect(result.customer).toBeNull();
    expect(result.alternatives).toHaveLength(2);
    expect(result.reason).toContain("PJが複数");
  });

  it("PJで見つからなければ氏名＋住所で照合する (台帳の住所に建物名が付いていても)", () => {
    const result = match(row(), [
      dx("9900000001", { address: "東京都架空区北町1-2-3　架空ハイツ101" }),
    ]);
    expect(result.confidence).toBe("probable");
    expect(result.reason).toContain("氏名と住所");
  });

  it("氏名だけの一致では照合しない", () => {
    const result = match(row(), [dx("9900000001", { address: "東京都架空区南町9-9-9" })]);
    expect(result.confidence).toBe("none");
    expect(result.reason).toContain("見つかりません");
  });

  it("棟の記号が食い違う顧客には結び付けない", () => {
    const result = match(row(), [
      dx("2101230101", { propertyName: "架空台1丁目 B号棟" }),
    ]);
    expect(result.customer).toBeNull();
  });

  it("顧客データが空なら見つからない", () => {
    expect(match(row(), []).confidence).toBe("none");
  });
});

describe("handoverDiff", () => {
  it("同じ日付なら一致 (表記のゆれは吸収する)", () => {
    const target = dx("2101230101", { handoverDate: "2025/09/26" });
    expect(handoverDiff(row(), target).status).toBe("same");
    expect(handoverDiff(row({ 引渡日: entry("2025/9/26") }), target).status).toBe("same");
  });

  it("顧客データが空欄・別の日付なら更新あり", () => {
    expect(handoverDiff(row(), dx("2101230101")).status).toBe("update");
    expect(
      handoverDiff(row(), dx("2101230101", { handoverDate: "2024/01/01" })).status,
    ).toBe("update");
  });

  it("報告書の引渡日が読めなければ更新しない", () => {
    const target = dx("2101230101");
    expect(handoverDiff(row({ 引渡日: entry("") }), target).status).toBe("invalid");
    expect(handoverDiff(row({ 引渡日: entry("2025/2/30") }), target).status).toBe("invalid");
    expect(handoverDiff(row({ 引渡日: entry("不明") }), target).status).toBe("invalid");
  });
});

describe("buildHandoverSync", () => {
  it("確実な一致だけをまとめて更新の対象にする", () => {
    const [item] = buildHandoverSync([row()], [dx("2101230101")]);
    expect(item.status).toBe("update");
    expect(item.autoApplicable).toBe(true);
    expect(item.reportDate).toBe("2025/09/26");
  });

  it("照合が確実でなければ対象にしない", () => {
    const [item] = buildHandoverSync(
      [row()],
      [dx("9900000001", { address: "東京都架空区北町1-2-3　架空ハイツ101" })],
    );
    expect(item.status).toBe("update");
    expect(item.autoApplicable).toBe(false);
    expect(item.holdReason).toContain("確実ではありません");
  });

  it("報告書の引渡日が要確認なら対象にしない", () => {
    const [item] = buildHandoverSync([row({}, "warn")], [dx("2101230101")]);
    expect(item.autoApplicable).toBe(false);
    expect(item.holdReason).toContain("要確認");
  });

  it("顧客データ側で手直しした引渡日は自動で上書きしない", () => {
    const target: Customer = {
      ...dx("2101230101"),
      edits: { handoverDate: "2020/01/01" },
      editedAt: 1,
    };
    const [item] = buildHandoverSync([row()], [target]);
    expect(item.customerDate).toBe("2020/01/01");
    expect(item.autoApplicable).toBe(false);
    expect(item.holdReason).toContain("手直し");
  });

  it("報告書から反映済みの引渡日は上書き対象のまま (再処理で直せる)", () => {
    const target: Customer = {
      ...dx("2101230101"),
      edits: { handoverDate: "2020/01/01" },
      reportSync: { handoverDate: "2020/01/01", at: 1, pj: "2101230101" },
      editedAt: 1,
    };
    const [item] = buildHandoverSync([row()], [target]);
    expect(item.autoApplicable).toBe(true);
  });

  it("同姓同名で住所が違う顧客は自動更新の対象にしない", () => {
    const [item] = buildHandoverSync(
      [row()],
      [sk("a", { pj: "2101230101", address: "東京都架空区南町9-9-9" })],
    );
    expect(item.match.confidence).toBe("probable");
    expect(item.autoApplicable).toBe(false);
  });

  it("処理に失敗した行は出さない", () => {
    const failed = { ...row(), error: "解析に失敗" };
    expect(buildHandoverSync([failed], [dx("2101230101")])).toEqual([]);
  });

  it("顧客が決まらない行は状態で分かる", () => {
    const [unmatched] = buildHandoverSync([row()], [dx("9900000001", { ownerName: "別人　次郎" })]);
    expect(unmatched.status).toBe("unmatched");
    const [ambiguous] = buildHandoverSync(
      [row()],
      [
        sk("a", { pj: "2101230101", ownerName: "別人　次郎", address: "東京都架空区南町1-1-1" }),
        sk("b", { pj: "2101230101", ownerName: "他人　三郎", address: "東京都架空区西町2-2-2" }),
      ],
    );
    expect(ambiguous.status).toBe("ambiguous");
  });
});
