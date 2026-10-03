import { describe, expect, it } from "vitest";
import { parsePj, pjKey } from "@/lib/shishutsu/pj";

// 支出報告書の 事業部ｺｰﾄﾞ / PJ / 現場コード / 現場枝番。値はすべて架空

describe("PJ の書き方をそろえる", () => {
  it("★「事業部-PJ-現場」", () => {
    expect(parsePj("21-56-1")).toEqual({ division: 21, pj: 56, site: 1, branch: null });
  });
  it("★「PJ-現場」は事業部 1（注文住宅）", () => {
    expect(parsePj("1056-1")).toEqual({ division: 1, pj: 1056, site: 1, branch: null });
  });
  it("★10桁は 事業部2桁＋PJ4桁＋現場2桁＋枝番2桁", () => {
    expect(parsePj("9901270355")).toEqual({ division: 99, pj: 127, site: 3, branch: 55 });
  });
  it("★10桁の事業部 10 は 1 と書く（11 はそのまま）", () => {
    expect(parsePj("1099990101")?.division).toBe(1);
    expect(parsePj("1199990101")?.division).toBe(11);
  });
  it("9桁は先頭の 0 が落ちた10桁", () => {
    expect(parsePj("199990101")).toEqual({ division: 1, pj: 9999, site: 1, branch: 1 });
  });
  it("全角・空白が混ざっても読む。読めなければ null", () => {
    expect(parsePj(" ２１－５６－１ ")).toEqual({ division: 21, pj: 56, site: 1, branch: null });
    expect(parsePj("未定")).toBeNull();
    expect(parsePj("")).toBeNull();
  });
  it("★突き合わせの鍵は枝番を見ない（10桁とハイフンの書き方が同じ鍵になる）", () => {
    expect(pjKey(parsePj("1099990155"))).toBe(pjKey(parsePj("9999-1")));
    expect(pjKey(parsePj("9901270301"))).toBe(pjKey(parsePj("99-127-3")));
    expect(pjKey(null)).toBeNull();
  });
});
