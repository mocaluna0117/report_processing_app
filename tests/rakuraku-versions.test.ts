import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ★Vercel で動かす Chromium（@sparticuz/chromium）と playwright-core の版を揃えておく。
 *   メジャー番号がずれると、起動しないか、動いても画面の扱いが変わって取得が壊れる。
 *   片方だけ上げたときにここで気付けるようにする。
 */
const json = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

describe("楽楽精算を操作するブラウザの版", () => {
  const pkg = json("package.json");

  it("★playwright-core と @sparticuz/chromium は版を固定している（^ や ~ を付けない）", () => {
    for (const name of ["playwright-core", "@sparticuz/chromium"]) {
      expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("★Chromium のメジャー番号が、playwright-core が想定する Chromium と同じ", () => {
    const browsers = json("node_modules/playwright-core/browsers.json") as { browsers: { name: string; browserVersion: string }[] };
    const expected = browsers.browsers.find((b) => b.name === "chromium")?.browserVersion.split(".")[0];
    const actual = json("node_modules/@sparticuz/chromium/package.json").version.split(".")[0];
    expect(actual).toBe(expected);
  });

  it("入っている版が package.json と同じ（入れ直し忘れに気付く）", () => {
    expect(json("node_modules/playwright-core/package.json").version).toBe(pkg.dependencies["playwright-core"]);
    expect(json("node_modules/@sparticuz/chromium/package.json").version).toBe(pkg.dependencies["@sparticuz/chromium"]);
  });
});
