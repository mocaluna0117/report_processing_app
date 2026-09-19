import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { KINDS, type RakurakuKind } from "@/lib/rakuraku/kinds";
import type { ProgressStage } from "@/lib/rakuraku/protocol";
import { type ScanRun, runScan } from "@/lib/rakuraku/scan";
import { scanSummary } from "@/lib/rakuraku/parse/list";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { oneRoute } from "./rakuraku/helpers/kinds";
import { startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 一覧から対象を見つけるまでを通しで確かめる（/api/rakuraku/scan の中身）。すべて架空の画面
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** 部門ごとに中身が変わる一覧を直接開く種類 */
function listKind(path: string): RakurakuKind {
  return oneRoute(KINDS.tenmatsu, { listPath: path, listUrlMarker: path.split("?")[0] });
}

interface Recorded {
  run: ScanRun;
  stages: ProgressStage[];
  lines: string[];
  page: Page;
}

async function prepare(
  overrides: Partial<Omit<ScanRun, "request">> & { request?: Partial<ScanRun["request"]> } = {},
): Promise<Recorded> {
  const page = await browser!.newPage();
  const stages: ProgressStage[] = [];
  const lines: string[] = [];
  const { request, ...rest } = overrides;
  const run: ScanRun = {
    page,
    tenant: { loginUrl: `${server!.url}/` },
    home: `${server!.url}/top_frameset.html`,
    kind: listKind("list_dept.html"),
    request: { deptCode: "1900", done: [], limit: 10, ...request },
    remembered: null,
    log: (line) => lines.push(line),
    progress: (stage) => stages.push(stage),
    deadlineAt: Date.now() + 60_000,
    timing: {
      list: { requestIntervalMs: 0, nextPageWaitMs: 2_000 },
      navigation: { frameWaitMs: 3_000, reopenWaitMs: 2_000, listTableWaitMs: 1_000 },
    },
    ...rest,
  };
  return { run, stages, lines, page };
}

async function failure(promise: Promise<unknown>): Promise<RakurakuError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof RakurakuError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

describe.skipIf(!browser)("一覧から対象を見つける（通し）", () => {
  it("★部門を切り替えて、その部門の「承認済み」で未取得の伝票だけを返す", async () => {
    const { run, stages, lines, page } = await prepare({ request: { deptCode: "1800", done: ["TE00018001"] } });
    const result = await runScan(run);
    expect(result.department).toEqual({ code: "1800", label: "アフターメンテナンス課(1800)" });
    // 承認依頼中の TE00018002 と、取得済みの TE00018001 は除く。別部門（1900）の伝票は1件も混ざらない
    expect(result.collect.targets.map((t) => t.denpyoNo)).toEqual(["TE00018003"]);
    expect(result.collect.targets[0].href).toContain("workflowDetailView");
    expect(result.collect.targets[0].meta.shinsei_date).toBe("2026/09/01");
    expect(result.collect.stoppedEarly).toBe(false);
    expect(result.collect.total).toBe(3);
    expect(result.remembered).toEqual({ id: "jibumon" });
    expect(result.route.id).toBe("jibumon");
    expect(stages).toEqual(["open", "department", "navigate", "collect"]);
    expect(lines).toContain("  所属部門を切り替えました: アフターメンテナンス課(1800)");
    expect(lines).toContain("顛末書一覧へ移動します");
    await page.context().close();
  });

  it("★件数で切り詰めない（何件取るかはブラウザが決める）", async () => {
    const { run, page } = await prepare({ request: { deptCode: "1900", limit: 1 } });
    const result = await runScan(run);
    expect(result.collect.targets.map((t) => t.denpyoNo)).toEqual(["TE00019003", "TE00019001"]);
    await page.context().close();
  });

  it("★伝票が1件も無い一覧は「対象なし」で、読み切れなかった扱いにしない", async () => {
    const { run, page } = await prepare({ kind: listKind("list_empty.html") });
    const result = await runScan(run);
    expect(result.collect.targets).toEqual([]);
    expect(result.collect.stoppedEarly).toBe(false);
    expect(scanSummary(result.collect, "顛末書")).toBe("新規対象はありません（0件すべてを確認しました）。");
    await page.context().close();
  });

  it("★閲覧権限が無い一覧は、使おうとしたこの時点で理由を返す", async () => {
    const { run, page } = await prepare({ kind: listKind("list_denied.html") });
    const error = await failure(runScan(run));
    expect(error.code).toBe("LIST_NOT_PERMITTED");
    await page.context().close();
  });

  it("★選べない部門を指定したら、一覧を開く前に止める", async () => {
    const { run, stages, page } = await prepare({ request: { deptCode: "9999" } });
    const error = await failure(runScan(run));
    expect(error.code).toBe("DEPT_NOT_AVAILABLE");
    expect(stages).not.toContain("navigate");
    await page.context().close();
  });

  it("★ログインが切れていたら SESSION_EXPIRED（ログインし直さない）", async () => {
    const { run, stages, page } = await prepare({ home: `${server!.url}/login_again.html` });
    const error = await failure(runScan(run));
    expect(error.code).toBe("SESSION_EXPIRED");
    expect(error.sessionLost).toBe(true);
    expect(stages).toEqual(["open"]);
    await page.context().close();
  });
});
