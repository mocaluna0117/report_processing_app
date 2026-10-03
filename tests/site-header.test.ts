import { describe, expect, it } from "vitest";
import { decideHeaderFit } from "@/components/site-header";

// 見出しの並べ方（2026-10-04）。幅は実測した値（画面の最大幅で 1232px 使える）
const base = { viewport: 1500, available: 1232, folio: 70 };

describe("見出しの並べ方", () => {
  it("入りきれば1段（画面名も出す）", () => {
    expect(decideHeaderFit({ ...base, title: 107, nav: 870, account: 102 })).toBe("full");
  });
  it("★タブが7つで画面名まで入らなければ、画面名を隠して1段（右上が重ならない）", () => {
    // kimura さん・アフターの画面: 70+132+976+102+32 = 1312 > 1232、画面名を隠すと 1180
    expect(decideHeaderFit({ ...base, title: 132, nav: 976, account: 102 })).toBe("compact");
  });
  it("★画面名を隠しても入らなければ2段", () => {
    expect(decideHeaderFit({ ...base, title: 132, nav: 1100, account: 160 })).toBe("two");
  });
  it("狭い画面はいつも2段", () => {
    expect(decideHeaderFit({ ...base, viewport: 1200, title: 10, nav: 10, account: 10 })).toBe("two");
  });
});
