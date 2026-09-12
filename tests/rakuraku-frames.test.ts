import type { Browser } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateFunctionString } from "@/lib/rakuraku/frames";
import { tryLaunch } from "./rakuraku/helpers/browser";

const browser: Browser | null = await tryLaunch();
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!browser)("文字列で持っている関数式の実行", () => {
  it("★Node 版の Playwright は文字列の関数式を呼び出さない（移植元の Python 版とは違う）", async () => {
    const page = await browser!.newPage();
    await page.setContent("<script>window.hit = 0;</script>");
    await page.mainFrame().evaluate("() => { window.hit++; }");
    expect(await page.evaluate(() => (window as unknown as { hit: number }).hit)).toBe(0);
    await page.close();
  });

  it("evaluateFunctionString は呼び出して結果を返す", async () => {
    const page = await browser!.newPage();
    await page.setContent("<script>window.hit = 0;</script>");
    const got = await evaluateFunctionString<number>(page.mainFrame(), "() => { window.hit++; return window.hit; }");
    expect(got).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { hit: number }).hit)).toBe(1);
    await page.close();
  });

  it("画面の onclick から読んだ処理（return を含む）も動く", async () => {
    const page = await browser!.newPage();
    await page.setContent("<script>window.fed = null; var K = { pageFeed: (n) => { window.fed = n; } };</script>");
    await evaluateFunctionString(page.mainFrame(), "() => { K.pageFeed(2); return false; }");
    expect(await page.evaluate(() => (window as unknown as { fed: number }).fed)).toBe(2);
    await page.close();
  });
});
