import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentDepartment,
  ensureDepartment,
  listDepartments,
} from "@/lib/rakuraku/department";
import { departmentNotAvailableText } from "@/lib/rakuraku/errors";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 手元にブラウザが無い環境では、この節ごと飛ばす。
// ★起こすのは1回だけ（判定のために2回起こさない）
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const QUALITY = "1900";
const AFTER = "1800";

async function open(path: string) {
  const page = await browser!.newPage();
  await page.goto(`${server!.url}/${path}`, { waitUntil: "load" });
  return page;
}

describe.skipIf(!browser)("部門の選択", () => {
    it("選べる部門を読める", async () => {
      const page = await open("dept-select.html");
      expect(await listDepartments(page)).toEqual([
        { code: AFTER, label: "アフターメンテナンス課(1800)" },
        { code: QUALITY, label: "品質管理部(1900)" },
      ]);
      await page.close();
    });

    it("いま選ばれている部門が分かる", async () => {
      const page = await open("dept-select.html");
      expect((await currentDepartment(page))?.code).toBe(QUALITY);
      await page.close();
    });

    it("すでにその部門なら何もしない", async () => {
      const page = await open("dept-select.html");
      const result = await ensureDepartment(page, QUALITY);
      expect(result.kind).toBe("already");
      // 画面の表示は変わっていない (onchange が走っていない)
      expect(await page.locator("#cur").innerText()).toBe("品質管理部(1900)");
      await page.close();
    });

    it("別の部門へ切り替えられる", async () => {
      const page = await open("dept-select.html");
      const result = await ensureDepartment(page, AFTER);
      expect(result.kind).toBe("selected");
      expect(await page.locator("#cur").innerText()).toBe("アフターメンテナンス課(1800)");
      await page.close();
    });

    it("★選択肢に無ければ not-available を返す (黙って別部門のまま続けない)", async () => {
      const page = await open("dept-select.html");
      const result = await ensureDepartment(page, "9999");
      expect(result.kind).toBe("not-available");
      if (result.kind === "not-available") {
        expect(result.available.map((d) => d.code)).toEqual([AFTER, QUALITY]);
      }
      // 画面は触られていない
      expect(await page.locator("#cur").innerText()).toBe("品質管理部(1900)");
      await page.close();
    });

    it("★プルダウンが無ければ no-select を返す (権限が無い可能性)", async () => {
      const page = await open("dept-missing.html");
      expect(await listDepartments(page)).toBeNull();
      expect(await currentDepartment(page)).toBeNull();
      expect((await ensureDepartment(page, QUALITY)).kind).toBe("no-select");
      await page.close();
    });
});

describe("選べないときの文言", () => {
  it("選べるものを添えて伝える", () => {
    expect(
      departmentNotAvailableText("品質管理部", [{ label: "アフターメンテナンス課(1800)" }]),
    ).toBe("このアカウントでは「品質管理部」を選べません。選べるのは アフターメンテナンス課(1800) です");
  });

  it("選択肢が空でも文になる", () => {
    expect(departmentNotAvailableText("品質管理部", [])).toContain("部門を選べません");
  });
});
