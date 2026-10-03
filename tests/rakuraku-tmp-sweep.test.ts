import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBrowserTemp, listBrowserTemp, sweepBrowserTemp } from "@/lib/rakuraku/tmp-sweep";

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
    expect(isBrowserTemp("chromium")).toBe(false);
    expect(isBrowserTemp("al2023")).toBe(false);
  });

  it("★ほかに動いているブラウザが無ければ、一時フォルダーを全部消す（Chromium 本体は残す）", async () => {
    await put("playwright_chromiumdev_profile-1/Default/Cache/data", 2 * 1024 * 1024);
    await put("playwright-artifacts-1/x");
    await put("rakuraku-1/dl/x");
    await put("chromium", 3 * 1024 * 1024);
    const report = await sweepBrowserTemp(base);
    expect((await readdir(base)).sort()).toEqual(["chromium"]);
    expect(report).toMatchObject({ n_tmp_swept: 3, n_tmp_swept_mb: 2, n_tmp_other_n: 1, n_tmp_other_mb: 3 });
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

  it("場所が無くても投げない", async () => {
    await expect(sweepBrowserTemp(join(base, "none"))).resolves.toMatchObject({ n_tmp_swept: 0 });
  });
});
