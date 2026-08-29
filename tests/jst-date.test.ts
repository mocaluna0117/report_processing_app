import { describe, expect, it } from "vitest";
import { formatDateNoPadJst, formatLastUpdatedJst, formatRemarksJst } from "@/lib/jst-date";

describe("formatLastUpdatedJst / formatRemarksJst", () => {
  it("「⚪︎月⚪︎日」形式 (ゼロ埋めなし)", () => {
    expect(formatLastUpdatedJst(new Date("2026-01-04T10:00:00+09:00"))).toBe(
      "1月4日",
    );
    expect(formatLastUpdatedJst(new Date("2026-08-26T10:00:00+09:00"))).toBe(
      "8月26日",
    );
  });

  it("備考欄は「⚪︎/⚪︎　点検報告書作成」形式 (全角スペース区切り)", () => {
    expect(formatRemarksJst(new Date("2026-08-26T10:00:00+09:00"))).toBe(
      "8/26　点検報告書作成",
    );
  });

  it("実行環境のタイムゾーンに関わらず日本標準時で日付を決める (UTC深夜=JST翌日)", () => {
    const utcLateNight = new Date("2026-08-25T15:30:00Z"); // JSTでは 8/26 00:30
    expect(formatLastUpdatedJst(utcLateNight)).toBe("8月26日");
    expect(formatRemarksJst(utcLateNight)).toBe("8/26　点検報告書作成");
  });
});

describe("formatDateNoPadJst", () => {
  it("日本時間の年月日をゼロ埋めなしで返す", () => {
    expect(formatDateNoPadJst(new Date("2026-08-30T03:00:00Z"))).toBe("2026/8/30");
  });

  it("UTCの深夜は日本時間では翌日", () => {
    expect(formatDateNoPadJst(new Date("2026-08-29T15:30:00Z"))).toBe("2026/8/30");
  });
});
