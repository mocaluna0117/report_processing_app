import { describe, expect, it } from "vitest";
import { applyEdits } from "@/lib/after/customer";
import {
  buildRowStaff,
  buildStaffSync,
  hasStaffFields,
  indexCustomersByPjPrefix,
  pjPrefix,
  resolveStaffValue,
  staffUpdatesFor,
} from "@/lib/after/match-staff";
import type { Customer, CustomerFields, CustomerSource } from "@/lib/after/types";
import { type CellEntry, buildCells, entry } from "@/lib/cells";
import type { ResultRow } from "@/lib/process";
import { DEFAULT_REPORT_OPTIONS } from "@/lib/report/model";
import { SALES_COL, SUPERVISOR_COL } from "@/lib/tsv";
import type { ListItem } from "@/lib/tenmatsu/client";

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

/** 顛末書の1行 (PC側の /list が返す形) */
const item = (over: Partial<ListItem> = {}): ListItem => ({
  denpyo_no: "TE00001476",
  file: "顛末書No.1476.pdf",
  at: null,
  exists: true,
  pages: 3,
  size: 1000,
  pj: "2101230101",
  // PC側が「姓　名」を「姓 名」(半角スペース1つ) に揃えて返す
  supervisor: "架空 一郎",
  sales_rep: "架空 二郎",
  ...over,
});

const row = (over: Partial<Record<string, CellEntry>> = {}): ResultRow => {
  const { cells, confidences } = buildCells({
    PJ: entry("2101230101"),
    お客様氏名: entry("架空　太郎"),
    ...over,
  });
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

describe("pjPrefix", () => {
  it("10桁の上8桁を返す (下2桁は棟の枝番)", () => {
    expect(pjPrefix("2101230101")).toBe("21012301");
    expect(pjPrefix("2101230102")).toBe("21012301");
  });

  it("全角・ハイフンを吸収する", () => {
    expect(pjPrefix("２１０１２３０１０１")).toBe("21012301");
    expect(pjPrefix("2101-23-0101")).toBe("21012301");
  });

  it("10桁でなければ null (推測で埋めない)", () => {
    for (const v of ["210123010", "21012301010", "PJ2101230101", "", null, undefined]) {
      expect(pjPrefix(v)).toBeNull();
    }
  });
});

describe("resolveStaffValue", () => {
  it("空の値は候補にしない (1棟だけ入っている状態を食い違いにしない)", () => {
    expect(resolveStaffValue(["架空 一郎", "", null, undefined])).toMatchObject({
      value: "架空 一郎",
      conflict: false,
    });
  });

  it("★空白の書き方が違うだけなら同じ値とみなす", () => {
    expect(resolveStaffValue(["架空　一郎", "架空 一郎"]).conflict).toBe(false);
  });

  it("★2種類あれば決めない (食い違い)", () => {
    const got = resolveStaffValue(["架空 一郎", "架空 五郎"]);
    expect(got.value).toBeNull();
    expect(got.conflict).toBe(true);
    expect(got.candidates).toHaveLength(2);
  });

  it("全部空なら値なし・食い違いでもない", () => {
    expect(resolveStaffValue(["", null])).toMatchObject({ value: null, conflict: false });
  });
});

describe("indexCustomersByPjPrefix", () => {
  it("上8桁でまとめる (同じ現場の別棟が同じキーに入る)", () => {
    const index = indexCustomersByPjPrefix([dx("2101230101"), dx("2101230102"), dx("2101239901")]);
    expect(index.get("21012301")).toHaveLength(2);
    expect(index.get("21012399")).toHaveLength(1);
  });

  it("PJが無い顧客は入れない", () => {
    expect(indexCustomersByPjPrefix([customer("sk:a", "suketto")]).size).toBe(0);
  });

  it("手直ししたPJを見る", () => {
    const edited = applyEdits(customer("sk:a", "suketto"), { pj: "2101230101" }, 1);
    expect(indexCustomersByPjPrefix([edited]).get("21012301")).toHaveLength(1);
  });
});

describe("buildStaffSync (顛末書 → お客様の情報)", () => {
  it("上8桁が違う棟でも突き合わせる", () => {
    const { rows } = buildStaffSync([item({ pj: "2101230102" })], [dx("2101230101")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].fields.supervisor.status).toBe("update");
    expect(rows[0].updates).toEqual([
      { id: "dx:2101230101", supervisor: "架空 一郎", salesRep: "架空 二郎" },
    ]);
  });

  it("同じ現場の顛末書は1行にまとまる", () => {
    const { rows } = buildStaffSync(
      [item({ denpyo_no: "A", pj: "2101230101" }), item({ denpyo_no: "B", pj: "2101230102" })],
      [dx("2101230101")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].denpyoNos).toEqual(["A", "B"]);
  });

  it("★同じ現場の顛末書で値が食い違うと見送る", () => {
    const { rows } = buildStaffSync(
      [item({ denpyo_no: "A" }), item({ denpyo_no: "B", supervisor: "架空 五郎" })],
      [dx("2101230101")],
    );
    expect(rows[0].fields.supervisor.status).toBe("conflict");
    expect(rows[0].fields.supervisor.reason).toContain("架空 五郎");
    // 食い違ったのは監督だけ。営業は入れられる
    expect(rows[0].fields.salesRep.status).toBe("update");
    expect(staffUpdatesFor(rows)).toEqual([{ id: "dx:2101230101", salesRep: "架空 二郎" }]);
  });

  it("★台帳の営業が入っている行は触らない (空欄のときだけ入れる)", () => {
    const { rows } = buildStaffSync([item()], [dx("2101230101", { salesRep: "台帳 営業" })]);
    expect(rows[0].fields.salesRep.status).toBe("kept");
    expect(rows[0].fields.supervisor.status).toBe("update");
    expect(staffUpdatesFor(rows)).toEqual([{ id: "dx:2101230101", supervisor: "架空 一郎" }]);
  });

  it("同じ値が入っていれば same (書かない)", () => {
    const { rows } = buildStaffSync([item()], [dx("2101230101", { supervisor: "架空 一郎" })]);
    expect(rows[0].fields.supervisor.status).toBe("same");
  });

  it("★同じ現場のお客様どうしで値が違うときは書かない", () => {
    const { rows } = buildStaffSync(
      [item()],
      [dx("2101230101", { supervisor: "架空 一郎" }), dx("2101230102", { supervisor: "架空 五郎" })],
    );
    expect(rows[0].fields.supervisor.status).toBe("conflict");
    expect(rows[0].updates.every((u) => u.supervisor === undefined)).toBe(true);
  });

  it("空欄の棟だけに入れる (値が揃っているとき)", () => {
    const { rows } = buildStaffSync(
      [item()],
      [dx("2101230101", { supervisor: "架空 一郎" }), dx("2101230102")],
    );
    expect(rows[0].fields.supervisor.status).toBe("update");
    // 監督は空欄の棟だけ。営業はどちらの棟も空欄なので両方に入る
    expect(rows[0].updates).toEqual([
      { id: "dx:2101230102", supervisor: "架空 一郎", salesRep: "架空 二郎" },
      { id: "dx:2101230101", salesRep: "架空 二郎" },
    ]);
  });

  it("全角スペースで届いても、同じ値なら入れ直さない", () => {
    const { rows } = buildStaffSync(
      [item({ supervisor: "架空　一郎" })],
      [dx("2101230101", { supervisor: "架空 一郎" })],
    );
    expect(rows[0].fields.supervisor.status).toBe("same");
  });

  it("手直しした値も「入っている値」として扱う", () => {
    const edited = applyEdits(dx("2101230101"), { supervisor: "手直し 太郎" }, 1);
    const { rows } = buildStaffSync([item()], [edited]);
    expect(rows[0].fields.supervisor.status).toBe("kept");
  });

  it("お客様が見つからない行も出す (黙って隠さない)", () => {
    const { rows } = buildStaffSync([item()], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].customers).toHaveLength(0);
    expect(rows[0].updates).toHaveLength(0);
  });

  it("PJが読めない顛末書・監督も営業も無い顛末書は件数で伝える", () => {
    const got = buildStaffSync(
      [
        item({ denpyo_no: "A", pj: null }),
        item({ denpyo_no: "B", supervisor: null, sales_rep: null }),
        item({ denpyo_no: "C" }),
      ],
      [dx("2101230101")],
    );
    expect(got.skippedNoPj).toBe(1);
    expect(got.skippedNoStaff).toBe(1);
    expect(got.rows).toHaveLength(1);
  });

  it("★PC側が未対応なら分かるようにする", () => {
    const old: ListItem = {
      denpyo_no: "A",
      file: "a.pdf",
      at: null,
      exists: true,
      pages: 1,
      size: 1,
    };
    expect(buildStaffSync([old], []).serverSupported).toBe(false);
    expect(buildStaffSync([item()], []).serverSupported).toBe(true);
    expect(hasStaffFields(old)).toBe(false);
    expect(hasStaffFields(item())).toBe(true);
  });

  it("入力の配列を書き換えない", () => {
    const items = [item()];
    const customers = [dx("2101230101")];
    buildStaffSync(items, customers);
    expect(items[0].supervisor).toBe("架空 一郎");
    expect(customers[0].imported.supervisor).toBe("");
  });
});

describe("buildRowStaff (お客様の情報 → 定期点検の行)", () => {
  const plan = (r: ResultRow, customers: Customer[]) => buildRowStaff([r], customers)[0];

  it("空欄の監督・営業に入れる", () => {
    const got = plan(row(), [dx("2101230101", { supervisor: "架空 一郎", salesRep: "架空 二郎" })]);
    expect(got.status).toBe("ready");
    expect(got.updates).toEqual([
      { col: SUPERVISOR_COL, value: "架空 一郎" },
      { col: SALES_COL, value: "架空 二郎" },
    ]);
  });

  it("上8桁で引く (下2桁が違う棟でも当たる)", () => {
    const got = plan(row({ PJ: entry("2101230199") }), [dx("2101230101", { supervisor: "架空 一郎" })]);
    expect(got.status).toBe("ready");
  });

  it("★手入力済みの値は上書きしない", () => {
    const got = plan(row({ 監督: entry("手入力 太郎") }), [
      dx("2101230101", { supervisor: "架空 一郎", salesRep: "架空 二郎" }),
    ]);
    // 監督は手入力済みなので触らず、空欄の営業だけ入れる
    expect(got.updates).toEqual([{ col: SALES_COL, value: "架空 二郎" }]);
  });

  it("同じ値が入っていれば何もしない", () => {
    const got = plan(row({ 監督: entry("架空 一郎"), 営業: entry("架空 二郎") }), [
      dx("2101230101", { supervisor: "架空 一郎", salesRep: "架空 二郎" }),
    ]);
    expect(got.status).toBe("filled");
    expect(got.updates).toHaveLength(0);
  });

  it("★お客様ごとに値が違うときは入れない", () => {
    const got = plan(row(), [
      dx("2101230101", { supervisor: "架空 一郎" }),
      dx("2101230102", { supervisor: "架空 五郎" }),
    ]);
    expect(got.status).toBe("conflict");
    expect(got.updates).toHaveLength(0);
    expect(got.reason).toContain("架空 五郎");
  });

  it("片方だけ空欄の棟があっても、値が揃っていれば入れる", () => {
    const got = plan(row(), [
      dx("2101230101", { supervisor: "架空 一郎" }),
      dx("2101230102"),
    ]);
    expect(got.updates).toEqual([{ col: SUPERVISOR_COL, value: "架空 一郎" }]);
  });

  it("お客様が見つからない・PJが読めない・値が無い、を見分ける", () => {
    expect(plan(row(), []).status).toBe("unmatched");
    expect(plan(row({ PJ: entry("21012") }), []).status).toBe("invalid");
    expect(plan(row(), [dx("2101230101")]).status).toBe("missing");
  });

  it("処理に失敗した行は対象にしない", () => {
    const broken = { ...row(), error: "読めませんでした" };
    expect(buildRowStaff([broken], [dx("2101230101")])).toHaveLength(0);
  });
});
