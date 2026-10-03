import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeNoCoreLauncher } from "@/lib/rakuraku/browser";
import { TMP_TOP_PATTERN } from "@/lib/rakuraku/log";
import { isBrowserTemp, listBrowserTemp, shapeOf, sweepBrowserTemp } from "@/lib/rakuraku/tmp-sweep";

// 2026-10-03: Vercel の /tmp がブラウザの一時フォルダーで埋まり、Chromium が起動直後に落ちていた（TARGET_CLOSED）

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "folio-sweep-test-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(path: string, bytes = 1024) {
  const full = join(base, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, Buffer.alloc(bytes));
}

describe("ブラウザの一時フォルダーの片付け", () => {
  it("名前の形で見分ける（Chromium 本体の展開先は対象外）", () => {
    expect(isBrowserTemp("playwright_chromiumdev_profile-abc")).toBe(true);
    expect(isBrowserTemp("playwright-artifacts-abc")).toBe(true);
    expect(isBrowserTemp(".org.chromium.Chromium.abc")).toBe(true);
    expect(isBrowserTemp("rakuraku-abc")).toBe(true);
    expect(isBrowserTemp(".cache")).toBe(true);
    expect(isBrowserTemp(".pki")).toBe(true);
    // ★Chromium のコアダンプ（2026-10-03 に /tmp を埋めていた本当の原因）
    expect(isBrowserTemp("core.chromium.12345")).toBe(true);
    expect(isBrowserTemp("core")).toBe(true);
    expect(isBrowserTemp("corefonts")).toBe(false);
    expect(isBrowserTemp("chromium")).toBe(false);
    expect(isBrowserTemp("al2023")).toBe(false);
  });

  it("★ほかに動いているブラウザが無ければ、一時フォルダーを全部消す（Chromium 本体は残す）", async () => {
    await put("playwright_chromiumdev_profile-1/Default/Cache/data", 2 * 1024 * 1024);
    await put("playwright-artifacts-1/x");
    await put("rakuraku-1/dl/x");
    await put(".cache/fontconfig/x", 1024 * 1024);
    await put("chromium", 3 * 1024 * 1024);
    await put("libvk_swiftshader.so", 1024);
    await put("unknown.bin", 4 * 1024 * 1024);
    const report = await sweepBrowserTemp(base);
    expect((await readdir(base)).sort()).toEqual(["chromium", "libvk_swiftshader.so", "unknown.bin"]);
    expect(report).toMatchObject({ n_tmp_swept: 4, n_tmp_swept_mb: 3, n_tmp_bin_mb: 3, n_tmp_other_n: 1, n_tmp_other_mb: 4 });
    expect(typeof report.n_tmp_free_after_mb).toBe("number");
  });

  it("★ほかのブラウザが動いているときは、動いている分（keep）と新しいものは消さない", async () => {
    await put("playwright_chromiumdev_profile-old/x");
    await put("playwright_chromiumdev_profile-new/x");
    await put("playwright_chromiumdev_profile-running/x");
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(join(base, "playwright_chromiumdev_profile-old"), hourAgo, hourAgo);
    await utimes(join(base, "playwright_chromiumdev_profile-running"), hourAgo, hourAgo);
    await sweepBrowserTemp(base, { onlyOlderThanMs: 10 * 60 * 1000, keep: new Set(["playwright_chromiumdev_profile-running"]) });
    expect((await readdir(base)).sort()).toEqual(["playwright_chromiumdev_profile-new", "playwright_chromiumdev_profile-running"]);
  });

  it("手元の PC では消す形をしぼれる（自前の rakuraku- だけ）", async () => {
    await put("playwright_chromiumdev_profile-x/x");
    await put("rakuraku-x/x");
    await sweepBrowserTemp(base, { only: [/^rakuraku-/] });
    expect(await readdir(base)).toEqual(["playwright_chromiumdev_profile-x"]);
    expect([...(await listBrowserTemp(base))]).toEqual(["playwright_chromiumdev_profile-x"]);
  });

  it("★正体の分からないものは「名前の形」と大きさをログに出せる形で返す（数字・長い英数字は伏せる）", async () => {
    await put("mystery-AbCdEf123456/inner-12345.dat", 2 * 1024 * 1024);
    await put("dump.4567", 1024 * 1024);
    const report = await sweepBrowserTemp(base);
    expect(report.tmp_top).toBe("mystery-*/inner-#.dat:2,dump.#:1");
    expect(TMP_TOP_PATTERN.test(report.tmp_top!)).toBe(true);
    expect(shapeOf("顛末書№1234.pdf")).toBe("No#.pdf");
    expect(shapeOf("")).toBe("?");
  });

  it("場所が無くても投げない", async () => {
    await expect(sweepBrowserTemp(join(base, "none"))).resolves.toMatchObject({ n_tmp_swept: 0 });
  });
});

describe.skipIf(process.platform === "win32")("コアダンプを書かせない起動スクリプト", () => {
  it("★コアダンプの上限を 0 にしてから、引数をそのまま渡して起こす", async () => {
    const launcher = await writeNoCoreLauncher("/bin/sh", base);
    expect(launcher).toBe(join(base, "chromium-nocore.sh"));
    const run = spawnSync(launcher!, ["-c", 'ulimit -c; echo "$1 $2"', "x", "架空 の", "引数"], { encoding: "utf8" });
    expect(run.stdout.trim().split("\n")).toEqual(["0", "架空 の 引数"]);
  });

  it("実行ファイルの場所に ' が入っていても壊れない", async () => {
    const dir = join(base, "it's");
    await mkdir(dir);
    const target = join(dir, "echo.sh");
    await writeFile(target, '#!/bin/sh\necho ok "$@"\n');
    await import("node:fs/promises").then((fs) => fs.chmod(target, 0o755));
    const launcher = await writeNoCoreLauncher(target, base);
    expect(spawnSync(launcher!, ["a"], { encoding: "utf8" }).stdout.trim()).toBe("ok a");
  });
});
