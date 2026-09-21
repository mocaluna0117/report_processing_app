import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentDepartment,
  departmentsBody,
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

describe("応答の形（プルダウンが無いのは失敗ではない）", () => {
  const quality = { code: QUALITY, label: "品質管理部(1900)" };

  it("★プルダウンが無いアカウントは、空の一覧＋「切り替え無し」として返す", () => {
    expect(departmentsBody(null, null)).toEqual({ departments: [], hasDepartmentSelect: false, current: null });
  });

  it("★プルダウンはあるが選択肢が空、とは分けて返す", () => {
    expect(departmentsBody([], null)).toEqual({ departments: [], hasDepartmentSelect: true, current: null });
  });

  it("選べる部門はそのまま返す", () => {
    expect(departmentsBody([quality], quality)).toEqual({
      departments: [quality],
      hasDepartmentSelect: true,
      current: quality,
    });
  });
});

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

    it("★選択肢が空のプルダウンは [] を返す（プルダウンが無いのと混ぜない）", async () => {
      const page = await open("dept-select-empty.html");
      expect(await listDepartments(page)).toEqual([]);
      expect(await currentDepartment(page)).toBeNull();
      expect(await ensureDepartment(page, QUALITY)).toEqual({ kind: "not-available", available: [] });
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

describe.skipIf(!browser)("★切り替えが楽楽精算に覚えられるまで待つ（移植元は待っていなかった）", () => {
  // トップの部門プルダウンはフォームの送り直しで切り替わり、応答と一緒に覚えられる作り。
  // 応答は 800ミリ秒遅れて返る。一覧は「覚えている部門」の伝票だけを出す。
  const top = () => `${server!.url}/top_frameset.html`;
  const listIds = async (page: import("playwright-core").Page) => {
    const main = page.frame({ name: "main" })!;
    await main.evaluate((u) => {
      window.location.href = u;
    }, `${server!.url}/list_dept.html`).catch(() => null);
    await main.waitForURL(/list_dept\.html/);
    return await main.locator("#listTable a.w_denpyo").allInnerTexts();
  };

  it("（対照）選んだ直後に一覧へ移ると、切り替えが取り消されて**元の部門の一覧**を読んでしまう", async () => {
    const page = await browser!.newPage();
    await page.goto(top(), { waitUntil: "load" });
    // 移植元と同じ手順: 選ぶ → wait_for_load_state("load")（読み込み済みなので即座に返る）→ 一覧へ
    await page.frame({ name: "main" })!.locator('select[name="bumonCd"]').selectOption(AFTER);
    await page.waitForLoadState("load");
    expect(await listIds(page)).toEqual(["TE00019003", "TE00019002", "TE00019001"]);
    await page.context().close();
  });

  it("★ensureDepartment のあとなら、切り替えた部門の一覧になる", async () => {
    const page = await browser!.newPage();
    await page.goto(top(), { waitUntil: "load" });
    const result = await ensureDepartment(page, AFTER, { reopenUrl: top() });
    expect(result.kind).toBe("selected");
    expect(await listIds(page)).toEqual(["TE00018003", "TE00018002", "TE00018001"]);
    await page.context().close();
  });

  it("★開き直して読み直すので、応答がとても遅くても取り違えない", async () => {
    const page = await browser!.newPage();
    await page.goto(top(), { waitUntil: "load" });
    await page.frame({ name: "main" })!.evaluate(() => {
      (document.querySelector('input[name="delay"]') as HTMLInputElement).value = "2500";
    });
    const result = await ensureDepartment(page, AFTER, { reopenUrl: top() });
    expect(result.kind).toBe("selected");
    expect((await currentDepartment(page))?.code).toBe(AFTER);
    await page.context().close();
  });

  it("★待つ上限を過ぎても覚えられていなければ not-applied（成功扱いにしない）", async () => {
    const page = await browser!.newPage();
    await page.goto(top(), { waitUntil: "load" });
    await page.frame({ name: "main" })!.evaluate(() => {
      (document.querySelector('input[name="delay"]') as HTMLInputElement).value = "3000";
    });
    const result = await ensureDepartment(page, AFTER, { reopenUrl: top(), settleTimeoutMs: 500 });
    expect(result.kind).toBe("not-applied");
    if (result.kind === "not-applied") expect(result.current?.code).toBe(QUALITY);
    await page.context().close();
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
