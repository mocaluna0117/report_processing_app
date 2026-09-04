import { describe, expect, it } from "vitest";
import type { HealthPayload, ListItem } from "@/lib/tenmatsu/client";
import {
  LIST_FILTERS,
  type ListFilter,
  listCounts,
  resolvePerRun,
  visibleListItems,
} from "@/lib/tenmatsu/list-view";

const item = (no: string, over: Partial<ListItem> = {}): ListItem => ({
  denpyo_no: no,
  file: `顛末書No.${no.slice(-4)}.pdf`,
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
  budget_entered: false,
  cloud_stored: false,
  completed: false,
  flags_updated_at: null,
  ...over,
});

const both = (no: string, over: Partial<ListItem> = {}) =>
  item(no, { budget_entered: true, cloud_stored: true, completed: true, ...over });

/** 完了フラグに未対応のサーバー・この機能より前のキャッシュが返す形 */
const unknownFlags = (no: string, over: Partial<ListItem> = {}): ListItem => ({
  denpyo_no: no,
  file: `顛末書No.${no.slice(-4)}.pdf`,
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
  ...over,
});

const view = (filter: ListFilter = "all", showCompleted = false, keepNos?: Set<string>) => ({
  filter,
  showCompleted,
  keepNos,
});

const nos = (items: ListItem[]) => items.map((i) => i.denpyo_no);

/** デモと同じ並び (/list は記録に足した順の逆で返るので 9006 が先頭) */
const demo = () => [
  item("TE00009006", { exists: false, pages: null, size: null }),
  both("TE00009005"),
  both("TE00009004"),
  item("TE00009003", { cloud_stored: true }),
  item("TE00009002", { budget_entered: true }),
  item("TE00009001"),
];

describe("完了の非表示", () => {
  it("既定では完了した行を隠す", () => {
    expect(nos(visibleListItems(demo(), view()))).toEqual([
      "TE00009006",
      "TE00009003",
      "TE00009002",
      "TE00009001",
    ]);
  });

  it("切り替えると完了した行も出る (並びは変えない)", () => {
    expect(nos(visibleListItems(demo(), view("all", true)))).toEqual([
      "TE00009006",
      "TE00009005",
      "TE00009004",
      "TE00009003",
      "TE00009002",
      "TE00009001",
    ]);
  });

  it("片方だけ済んだ行は隠さない", () => {
    const rows = [item("A", { budget_entered: true }), item("B", { cloud_stored: true })];
    expect(nos(visibleListItems(rows, view()))).toEqual(["A", "B"]);
  });

  it("completed はサーバーの値をそのまま使う (folio で計算し直さない)", () => {
    // 両方 true なのに completed が false で届いたら、隠さないのが正しい
    const rows = [item("A", { budget_entered: true, cloud_stored: true, completed: false })];
    expect(nos(visibleListItems(rows, view()))).toEqual(["A"]);
  });

  it("フラグが分からない行は完了扱いにしない", () => {
    const rows = [unknownFlags("A"), both("B")];
    expect(nos(visibleListItems(rows, view()))).toEqual(["A"]);
  });

  it("PDFが消えている行は完了していても隠さない", () => {
    const rows = [both("A", { exists: false, pages: null, size: null }), both("B")];
    expect(nos(visibleListItems(rows, view()))).toEqual(["A"]);
  });

  it("今チェックを変えた行は完了になっても残す (押し間違いを戻せるように)", () => {
    const rows = [both("A"), both("B")];
    expect(nos(visibleListItems(rows, view("all", false, new Set(["A"]))))).toEqual(["A"]);
  });
});

describe("絞り込み", () => {
  it("選択肢は3つ", () => {
    expect(LIST_FILTERS.map((f) => f.value)).toEqual(["all", "budget", "cloud"]);
    expect(LIST_FILTERS.map((f) => f.label)).toEqual([
      "すべて",
      "実行予算が未入力",
      "クラウド未格納",
    ]);
  });

  it("実行予算が未入力のみ", () => {
    expect(nos(visibleListItems(demo(), view("budget")))).toEqual([
      "TE00009006",
      "TE00009003",
      "TE00009001",
    ]);
  });

  it("クラウド未格納のみ", () => {
    expect(nos(visibleListItems(demo(), view("cloud")))).toEqual([
      "TE00009006",
      "TE00009002",
      "TE00009001",
    ]);
  });

  it("絞り込み中は完了の切り替えが結果を変えない (完了と排他だから)", () => {
    const off = nos(visibleListItems(demo(), view("budget", false)));
    const on = nos(visibleListItems(demo(), view("budget", true)));
    expect(on).toEqual(off);
  });

  it("フラグが分からない行は絞り込みでも落とさない", () => {
    const rows = [unknownFlags("A"), item("B", { budget_entered: true })];
    expect(nos(visibleListItems(rows, view("budget")))).toEqual(["A"]);
  });
});

describe("件数の内訳", () => {
  it("3つの数が全件に分割される (既定)", () => {
    const c = listCounts(demo(), view());
    expect(c).toEqual({
      shown: 4,
      hiddenCompleted: 2,
      hiddenByFilter: 0,
      missingFile: 1,
      total: 6,
    });
    expect(c.shown + c.hiddenCompleted + c.hiddenByFilter).toBe(c.total);
  });

  it("絞り込み中も全件に分割される", () => {
    const c = listCounts(demo(), view("budget"));
    expect(c.shown).toBe(3);
    // 未入力の絞り込みは完了と排他なので、完了で隠す分は必ず0になる
    expect(c.hiddenCompleted).toBe(0);
    expect(c.hiddenByFilter).toBe(3);
    expect(c.shown + c.hiddenCompleted + c.hiddenByFilter).toBe(c.total);
  });

  it("完了も表示にすると隠す分が0になる", () => {
    const c = listCounts(demo(), view("all", true));
    expect(c).toMatchObject({ shown: 6, hiddenCompleted: 0, hiddenByFilter: 0, total: 6 });
  });

  it("ファイルが消えている件数は絞り込みの前の全件から数える", () => {
    const rows = [
      item("A", { exists: false, budget_entered: true }),
      item("B", { exists: false }),
      item("C"),
    ];
    // 絞り込みで A は外れるが、消えている件数は 2 のまま伝える
    expect(listCounts(rows, view("budget")).missingFile).toBe(2);
    expect(listCounts(rows, view("budget")).shown).toBe(2);
  });

  it("完了かつファイルなしの行は隠していないので hiddenCompleted に数えない", () => {
    const rows = [both("A", { exists: false }), both("B")];
    const c = listCounts(rows, view());
    expect(c).toEqual({
      shown: 1,
      hiddenCompleted: 1,
      hiddenByFilter: 0,
      missingFile: 1,
      total: 2,
    });
  });

  it("フラグが分からない行だけなら何も隠さない", () => {
    const rows = [unknownFlags("A"), unknownFlags("B")];
    expect(listCounts(rows, view())).toEqual({
      shown: 2,
      hiddenCompleted: 0,
      hiddenByFilter: 0,
      missingFile: 0,
      total: 2,
    });
  });

  it("0件でも落ちない", () => {
    expect(listCounts([], view())).toEqual({
      shown: 0,
      hiddenCompleted: 0,
      hiddenByFilter: 0,
      missingFile: 0,
      total: 0,
    });
  });
});

describe("resolvePerRun", () => {
  const health = (over: Partial<HealthPayload> = {}): HealthPayload => ({
    ok: true,
    service: "tenmatsu-local",
    version: 1,
    save_dir: "/Users/x/顛末書",
    job_state: "idle",
    max_per_run: 10,
    max_per_run_min: 1,
    max_per_run_max: 100,
    headless: true,
    demo: false,
    ...over,
  });
  /** 件数指定に未対応のサーバー (5個しか返さない) */
  const oldHealth = {
    ok: true,
    service: "tenmatsu-local",
    version: 1,
    save_dir: "",
    job_state: "idle",
  } as HealthPayload;

  it("保存値が範囲内ならそれを使う", () => {
    expect(resolvePerRun(30, health())).toEqual({
      value: 30,
      min: 1,
      max: 100,
      fromServer: true,
      clamped: false,
    });
  });

  it("保存値が無ければサーバーの既定値", () => {
    expect(resolvePerRun(null, health({ max_per_run: 25 })).value).toBe(25);
    expect(resolvePerRun(undefined, health()).value).toBe(10);
  });

  it("保存値が範囲外なら丸めて、丸めたことを伝える", () => {
    expect(resolvePerRun(150, health())).toMatchObject({ value: 100, clamped: true });
    expect(resolvePerRun(0, health())).toMatchObject({ value: 1, clamped: true });
  });

  it("整数でない保存値は無視する", () => {
    expect(resolvePerRun(10.5, health())).toMatchObject({ value: 10, clamped: false });
    expect(resolvePerRun(Number.NaN, health())).toMatchObject({ value: 10, clamped: false });
  });

  it("件数指定に未対応のサーバーでは fromServer が false", () => {
    expect(resolvePerRun(30, oldHealth)).toEqual({
      value: 30,
      min: 1,
      max: 100,
      fromServer: false,
      clamped: false,
    });
  });

  it("繋ぐ前 (null) でも既定値を返す", () => {
    expect(resolvePerRun(null, null)).toEqual({
      value: 10,
      min: 1,
      max: 100,
      fromServer: false,
      clamped: false,
    });
  });
});
