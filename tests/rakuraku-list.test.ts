import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KINDS, type ResolvedKind, resolveKind } from "@/lib/rakuraku/kinds";
import { advancePage, collectTargets, readPager, readTableRows, scanListForNo } from "@/lib/rakuraku/list";
import { contentFrame } from "@/lib/rakuraku/frames";
import { isApproved } from "@/lib/rakuraku/parse/list";
import { parsePropertyName } from "@/lib/rakuraku/parse/fields";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 期待値は移植元の検証 (tenmatsu-dl/smoke_test.py「実構造」) から写した。すべて架空の値
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// 経路を1つに決めた種類（一覧の行を読む関数はこれを受け取る）
const kind: ResolvedKind = resolveKind(KINDS.tenmatsu, KINDS.tenmatsu.routes[0]);
/** 検証用に待ち時間を縮める（本番は 1.5秒・15秒） */
const QUICK = { requestIntervalMs: 0, nextPageWaitMs: 4_000 };
/**
 * 差し替えが遅い画面を試すとき用。
 * ★仕掛けの遅れ（2.5秒）に QUICK の 4秒だと余裕が1.5秒しかなく、
 *   ほかのテストと同時に走って重いときに時間切れで落ちる。ここで見たいのは
 *   「遅くても最終ページと誤判定しない」という**筋道**なので、本番（15秒）寄りの余裕を与える。
 */
const PATIENT = { requestIntervalMs: 0, nextPageWaitMs: 12_000 };

async function openList(opts: { pages?: number; mode?: string; delay?: number } = {}): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(`${server!.url}/list_structure.html`, { waitUntil: "load" });
  if (opts.pages) {
    await page.evaluate(
      (a) => {
        const w = window as unknown as { __pageFeedDelayMs: number; __setupPager: (p: number, m?: string) => void };
        w.__pageFeedDelayMs = a.delay;
        w.__setupPager(a.pages, a.mode);
      },
      { pages: opts.pages, mode: opts.mode ?? "absolute", delay: opts.delay ?? 100 },
    );
  }
  return page;
}

const pageNo = (page: Page) => page.evaluate(() => (window as unknown as { __pageNo: number }).__pageNo);

/** 「次へ」に入っている pageFeed の引数を読む */
const nextArg = (page: Page) =>
  page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("#pagerButtons a")).find((x) =>
      (x.textContent || "").includes("chevron_right"),
    );
    const m = a && /pageFeed\(\s*(-?\d+)\s*\)/.exec(a.getAttribute("onclick") || "");
    return m ? Number(m[1]) : null;
  });

describe.skipIf(!browser)("一覧の表を読む（実画面と同じ13列の構造）", () => {
  it("5行読める・伝票No.・状態・伝票画面の URL", async () => {
    const page = await openList();
    const rows = await readTableRows(await contentFrame(page), kind);
    expect(rows).toHaveLength(5);
    expect(rows[0].denpyo_no).toBe("TE00009001");
    expect(rows[1].status).toBe("承認済み");
    expect(rows[0].href).toContain("workflowDetailView");
    await page.close();
  });

  it("★承認済みの2件だけを対象にする（依頼中・取下げ・差戻しは除外）", async () => {
    const page = await openList();
    const rows = await readTableRows(await contentFrame(page), kind);
    expect(rows.filter((r) => isApproved(r.status, kind.list.approvedValues)).map((r) => r.denpyo_no)).toEqual([
      "TE00009002",
      "TE00009003",
    ]);
    await page.close();
  });

  it("画面の一覧に出す列を見出しの文字で探して読む", async () => {
    const page = await openList();
    const r1 = (await readTableRows(await contentFrame(page), kind)).find((r) => r.denpyo_no === "TE00009001")!;
    expect(r1.shinsei_date).toBe("2026/09/01");
    expect(r1.shinseisha).toBe("テスト 太郎");
    expect(r1.amount).toBe("71,500 円");
    expect(r1.payee).toBe("テスト商事");
    expect(r1.where).toBe("注文受注物件：テスト物件A 施主名：テスト 太郎");
    expect(parsePropertyName(r1.where)).toBe("テスト物件A");
    await page.close();
  });

  it("★表示が切れている列は title 属性の全文を採る", async () => {
    const page = await openList();
    const rows = await readTableRows(await contentFrame(page), kind);
    expect(rows.find((r) => r.denpyo_no === "TE00009003")!.where).toBe("注文受注物件：テスト物件C 施主名：テスト 次郎");
    await page.close();
  });

  it("空欄は null で返る", async () => {
    const page = await openList();
    const rows = await readTableRows(await contentFrame(page), kind);
    expect(rows.find((r) => r.denpyo_no === "TE00009005")!.where).toBeNull();
    await page.close();
  });

  it("見つからない列は null になり、見出しを空にした列はキーごと出さない", async () => {
    const page = await openList();
    const altered: ResolvedKind = {
      ...kind,
      list: { ...kind.list, columns: { ...kind.list.columns, amount: "存在しない列名", where: "" } },
    };
    const rows = await readTableRows(await contentFrame(page), altered);
    expect(rows).toHaveLength(5);
    expect(rows[0].amount).toBeNull();
    expect(rows[0].shinsei_date).toBe("2026/09/01");
    expect(rows[0]).not.toHaveProperty("where");
    await page.close();
  });

  it("件数表示を読める", async () => {
    const page = await openList();
    expect(await readPager(await contentFrame(page))).toEqual([5, 1, 5]);
    await page.close();
  });
});

describe.skipIf(!browser)("ページ送り — 2ページ目から先へ進めなかった不具合の再発防止", () => {
  it("★毎ページ「次へ」を画面から読み直し、4ページ目まで進める", async () => {
    const page = await openList({ pages: 4 });
    expect(await nextArg(page)).toBe(1); // 1ページ目の「次へ」は pageFeed(1)（固定の JS と同じ）
    const reached = [1];
    const memo = {};
    for (let i = 0; i < 4; i++) {
      const frame = await contentFrame(page);
      const moved = await advancePage(page, frame, kind, await readPager(frame), memo, QUICK);
      if (!moved.ok) break;
      reached.push(await pageNo(page));
    }
    expect(reached).toEqual([1, 2, 3, 4]);
    await page.close();
  }, 60_000);

  it("★2ページ目で固定の pageFeed(1) を呼んでも動かない（不具合の再現）", async () => {
    const page = await openList({ pages: 4 });
    const frame = await contentFrame(page);
    await advancePage(page, frame, kind, await readPager(frame), {}, QUICK);
    expect(await pageNo(page)).toBe(2);
    await page.evaluate(() => (window as unknown as { DenpyoKensaku: { pageFeed: (n: number) => void } }).DenpyoKensaku.pageFeed(1));
    await page.waitForTimeout(400);
    expect(await pageNo(page)).toBe(2);
    await page.close();
  }, 30_000);

  it("相対（-1/+1）の作りでも進める", async () => {
    const page = await openList({ pages: 3, mode: "relative" });
    const frame = await contentFrame(page);
    expect((await advancePage(page, frame, kind, await readPager(frame), {}, QUICK)).ok).toBe(true);
    expect(await pageNo(page)).toBe(2);
    await page.close();
  }, 30_000);

  it("アイコン名が無くても件数表示から「次へ」を選べる", async () => {
    const page = await openList({ pages: 4 });
    await page.evaluate(() => {
      for (const a of Array.from(document.querySelectorAll("#pagerButtons a"))) a.textContent = "";
    });
    const frame = await contentFrame(page);
    expect((await advancePage(page, frame, kind, await readPager(frame), {}, QUICK)).ok).toBe(true);
    expect(await pageNo(page)).toBe(2);
    await page.close();
  }, 30_000);

  it("効かないページ送りは失敗を返し、持ち時間を大きく超えない", async () => {
    const page = await openList({ pages: 4 });
    await page.evaluate(() => {
      (window as unknown as { __pageFeedBroken: boolean }).__pageFeedBroken = true;
    });
    const frame = await contentFrame(page);
    const t0 = Date.now();
    const moved = await advancePage(page, frame, kind, await readPager(frame), {}, QUICK);
    expect(moved.ok).toBe(false);
    expect(moved.reason).toContain("表が変わりませんでした");
    expect(Date.now() - t0).toBeLessThan(20_000);
    await page.close();
  }, 60_000);

  it("★差し替えに2.5秒かかっても最終ページと誤判定しない", async () => {
    const page = await openList({ pages: 4, delay: 2_500 });
    const frame = await contentFrame(page);
    expect((await advancePage(page, frame, kind, await readPager(frame), {}, PATIENT)).ok).toBe(true);
    await page.close();
  }, 60_000);

  it("★別のページへ飛んだら、黙って続けずに止めて理由を出す", async () => {
    const page = await openList({ pages: 4, mode: "jump" });
    const scan = await collectTargets(page, kind, { done: [], limit: 99, timing: QUICK });
    expect(scan.stoppedEarly).toBe(true);
    expect(scan.reason).toContain("飛びました");
    await page.close();
  }, 60_000);

  it("★最後のページならページ送りを試さない", async () => {
    const page = await openList();
    await page.evaluate(() => {
      (window as unknown as { __pageFeedCalled: unknown }).__pageFeedCalled = null;
    });
    const scan = await collectTargets(page, kind, { done: [], limit: 99, timing: QUICK });
    expect(await page.evaluate(() => (window as unknown as { __pageFeedCalled: unknown }).__pageFeedCalled)).toBeNull();
    expect(scan.stoppedEarly).toBe(false);
    expect(scan.total).toBe(5);
    await page.close();
  }, 30_000);
});

describe.skipIf(!browser)("対象を集める", () => {
  it("承認済みで、保存済み・保留中でないものだけ", async () => {
    const page = await openList();
    const scan = await collectTargets(page, kind, { done: ["TE00009002"], limit: 99, timing: QUICK });
    expect(scan.targets.map((t) => t.denpyoNo)).toEqual(["TE00009003"]);
    expect(scan.scanned).toBe(5);
    await page.close();
  });

  it("一覧から読んだ項目を meta に入れる", async () => {
    const page = await openList();
    const scan = await collectTargets(page, kind, { done: [], limit: 99, timing: QUICK });
    expect(scan.targets[0].meta).toMatchObject({ shinsei_date: expect.any(String), payee: expect.any(String) });
    expect(Object.keys(scan.targets[0].meta).sort()).toEqual(Object.keys(kind.list.columns).sort());
    await page.close();
  });

  it("進捗の行を出す", async () => {
    const page = await openList();
    const lines: string[] = [];
    await collectTargets(page, kind, { done: [], limit: 99, timing: QUICK, log: (l) => lines.push(l) });
    expect(lines[0]).toContain("1ページ目: 5行");
    expect(lines[0]).toContain("対象 累計2件");
    await page.close();
  });

  it("★時間の上限に近ければ次のページへ進まず、理由を付けて止める", async () => {
    const page = await openList({ pages: 4 });
    const scan = await collectTargets(page, kind, { done: [], limit: 99, timing: QUICK, deadlineAt: Date.now() - 1 });
    expect(scan.stoppedEarly).toBe(true);
    expect(scan.reason).toContain("時間の上限");
    await page.close();
  });
});

describe.skipIf(!browser)("紐づく伝票を一覧から探す（捺印決裁書 → 専決決裁書）", () => {
  it("★ページを送って探せる（先頭の0は無視）", async () => {
    const page = await openList({ pages: 4 });
    const found = await scanListForNo(page, kind, "00009300", { timing: QUICK });
    expect(found?.denpyoNo).toBe("TE00009300");
    expect(found?.href).toContain("workflowDetailView");
    await page.close();
  }, 60_000);

  it("★見つからなければ null（近い行を返さない）・最後のページまで見たら余計に送らない", async () => {
    const page = await openList({ pages: 2 });
    expect(await scanListForNo(page, kind, "99999", { timing: QUICK })).toBeNull();
    expect(await pageNo(page)).toBe(2);
    await page.close();
  }, 60_000);

  it("ページ送りが効かなくても固まらない", async () => {
    const page = await openList({ pages: 4 });
    await page.evaluate(() => {
      (window as unknown as { __pageFeedBroken: boolean }).__pageFeedBroken = true;
    });
    expect(await scanListForNo(page, kind, "00009300", { timing: QUICK })).toBeNull();
    await page.close();
  }, 60_000);
});

describe.skipIf(!browser)("読むページ数の上限", () => {
  it("★上限のページを読んだら、次のページを開かずに「上限に達した」と返す", async () => {
    const page = await openList({ pages: 4 });
    const scan = await collectTargets(page, kind, { done: [], limit: 100, timing: QUICK, maxPages: 2 });
    expect(scan.pages).toBe(2);
    expect(scan.stoppedEarly).toBe(true);
    expect(scan.reason).toBe("ページ数の上限（2ページ）に達しました");
    // 2ページ目までしか送っていない（3ページ目を開いていない）
    expect(await page.evaluate(() => (window as unknown as { __pageNo: number }).__pageNo)).toBe(2);
    await page.close();
  });

  it("★件数表示が「0件中」なら、表が読めなくても「読み切れなかった」にしない", async () => {
    const page = await browser!.newPage();
    await page.goto(`${server!.url}/list_empty.html`, { waitUntil: "load" });
    const scan = await collectTargets(page, kind, { done: [], limit: 10, timing: QUICK });
    expect(scan.targets).toEqual([]);
    expect(scan.stoppedEarly).toBe(false);
    expect(scan.total).toBe(0);
    await page.close();
  });
});
