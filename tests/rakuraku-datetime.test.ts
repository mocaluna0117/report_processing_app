import { describe, expect, it } from "vitest";
import {
  datetimeSortKey,
  hasTimePart,
  normalizeDatetimeText,
  pickLatestDate,
} from "@/lib/rakuraku/parse/datetime";

// 期待値は移植元の検証 (tenmatsu-dl/server_test.py の「日付の正規化」) から写した
describe("日付の正規化 — 画面の書き方の揺れを1つの形に揃える（元の精度は保つ）", () => {
  const cases: [string | null, string | null][] = [
    ["2026/09/04", "2026/09/04"],
    ["2026/09/04 17:51", "2026/09/04 17:51"],
    ["2026/09/04 17:51:38", "2026/09/04 17:51:38"],
    ["2026-09-04", "2026/09/04"],
    ["2026/9/4", "2026/09/04"],
    ["2026年9月4日 17時51分38秒", "2026/09/04 17:51:38"],
    ["2026/09/04（金）17:51", "2026/09/04 17:51"],
    ["２０２６／０９／０４　１７：５１", "2026/09/04 17:51"],
    ["承認 2026/09/04 17:51:38 架空 一郎", "2026/09/04 17:51:38"],
    // ★壊れた時刻は捨てて日付だけ返す（日付は使えるため）
    ["2026/09/04 25:00", "2026/09/04"],
    // ★実在しない日付は推測で直さず捨てる
    ["9999/99/99", null],
    ["2026/02/30", null],
    ["承認済", null],
    ["1件中1件", null],
    ["", null],
    [null, null],
  ];
  for (const [raw, want] of cases) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(want)}`, () => {
      expect(normalizeDatetimeText(raw)).toBe(want);
    });
  }

  it("うるう年は通す", () => {
    expect(normalizeDatetimeText("2024/02/29")).toBe("2024/02/29");
  });

  it("★日付より前にある数字を時刻と読み違えない", () => {
    expect(normalizeDatetimeText("12:34 に申請 2026/09/04")).toBe("2026/09/04");
  });
});

describe("並べ替えの鍵", () => {
  it("時刻の有無を見分ける", () => {
    expect(hasTimePart("2026/09/04 17:51")).toBe(true);
    expect(hasTimePart("2026/09/04")).toBe(false);
    expect(hasTimePart(null)).toBe(false);
  });

  it("同じ日なら時刻がある方が後", () => {
    expect(datetimeSortKey("2026/09/04 00:01") > datetimeSortKey("2026/09/04")).toBe(true);
  });

  it("空は空のまま", () => {
    expect(datetimeSortKey(null)).toBe("");
  });
});

describe("いちばん新しい日付を選ぶ", () => {
  it("秒まである方が後になる", () => {
    expect(pickLatestDate(["2026/09/04", "2026/09/04 17:51:38", "2026/09/03"])).toBe(
      "2026/09/04 17:51:38",
    );
  });

  it("★除きたい語を含む行は候補から外す（差戻しの日を最終承認日にしない）", () => {
    expect(
      pickLatestDate(["承認 2026/09/05", "差戻し 2026/09/08", "承認 2026/09/06"], ["差戻し"]),
    ).toBe("2026/09/06");
  });

  it("日付が1つも無ければ null", () => {
    expect(pickLatestDate(["承認済", "", null])).toBeNull();
  });

  it("空の入力でも落ちない", () => {
    expect(pickLatestDate(null)).toBeNull();
  });
});
