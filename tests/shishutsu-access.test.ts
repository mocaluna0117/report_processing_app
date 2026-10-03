import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPENSE_REPORT_ACCOUNT_IDS, canUseExpenseReport } from "@/lib/shishutsu/access";

/** コメントを除いた中身（コメントの文で通ってしまわないように） */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("支出報告書を使える人", () => {
  it("★1人目のアカウント kimura だけ（2026-10-03）", () => {
    expect(EXPENSE_REPORT_ACCOUNT_IDS).toEqual(["kimura"]);
    expect(canUseExpenseReport("kimura")).toBe(true);
    expect(canUseExpenseReport("someone")).toBe(false);
    expect(canUseExpenseReport(null)).toBe(false);
    expect(canUseExpenseReport(undefined)).toBe(false);
  });

  it("★ページは Redis のアカウントで確かめてから画面を出す（手元の開発で認証が無いときだけ素通り）", () => {
    const page = code("app/shishutsu/page.tsx");
    expect(page).toContain("await accountPageState(");
    expect(page).toContain("canUseExpenseReport(state.record.id) || state.forced");
    // 画面を出すのは「認証なし」と「確かめたあと」の2か所だけ
    expect(page.match(/<ShishutsuPage \/>/g)).toHaveLength(2);
    expect(page.indexOf('if (state.kind === "off") return <ShishutsuPage />;')).toBeGreaterThan(0);
    expect(page.indexOf("canUseExpenseReport(state.record.id)")).toBeLessThan(page.lastIndexOf("<ShishutsuPage />"));
  });

  it("タブは同じ判定で出し分ける（見た目だけ）", () => {
    expect(code("components/mode-nav.tsx")).toContain("canUseExpenseReport(signedIn?.id)");
  });
});
