import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 完了報告書の小窓（components/report-dialog.tsx）の指示内容の補足（画面のテスト基盤が無いので、中身を読んで見張る）。
const code = readFileSync(resolve(__dirname, "../components/report-dialog.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

describe("★指示内容の補足は、1つの項目にいくつでも（2026-09-25）", () => {
  it("「＋補足」は項目の行にいつも出す（1つ付けても消えない）", () => {
    expect(code).not.toMatch(/openSupplements|toggleSupplement|showSupplement/);
    const row = code.slice(code.indexOf("onClick={() => addSupplement(gi, i)}") - 400, code.indexOf("onClick={() => addSupplement(gi, i)}"));
    expect(row).not.toMatch(/\{\s*!\w+\s*&&\s*\(\s*$/);
    expect(code).toContain("＋補足");
  });

  it("補足は1つずつ行にし、それぞれに削除の ✕ と読み上げ用の名前がある", () => {
    expect(code).toContain("itemSupplements.map((supplement, j) =>");
    expect(code).toContain('title="この補足を削除"');
    expect(code).toContain("aria-label={`${itemLabel}の補足${j + 1}`}");
  });

  it("★「＋補足」を押しただけでは書き戻さない（下書きだけ。本文も報告書も変わらない）", () => {
    const add = code.slice(code.indexOf("const addSupplement ="), code.indexOf("const addItem ="));
    expect(add).toContain("keepDraft(");
    expect(add).not.toContain("editGroup(");
  });

  it("★別紙の知らせの判定は、補足の数で見る（並びは空でも真になるため）", () => {
    expect(code).toContain("data.supplements.some((s) => s.length > 0)");
  });
});
