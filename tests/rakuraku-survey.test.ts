import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KINDS } from "@/lib/rakuraku/kinds";
import {
  type SurveyReport,
  formatSurveyReport,
  pickQuery,
  redact,
  relativeTenantPath,
} from "@/lib/rakuraku/parse/survey";
import { clickAllowed, runSurvey } from "@/lib/rakuraku/survey";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { type FixtureServer, startFixtureServer } from "./rakuraku/helpers/fixture-server";
import { withRoutes } from "./rakuraku/helpers/kinds";

/**
 * 「画面の下見」。
 *
 * ★いちばん大事なのは「伝票の中身が報告に混ざらない」こと。見本の表とラベルの値には
 *   目印の文字（SECRET_CELL / SECRET_VALUE）を入れてあり、報告のどこにも出ないことを確かめる。
 */
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

let lines: string[] = [];
beforeEach(() => {
  lines = [];
});

/** 検証用に待ち時間を縮める（本番は 20秒・10秒・8秒）。表を待つ時間は詰めすぎない */
const QUICK = { frameWaitMs: 3_000, reopenWaitMs: 2_000, listTableWaitMs: 4_000 };

async function survey(page: Page): Promise<SurveyReport> {
  const tenant = { loginUrl: `${server!.url}/` };
  const denied = withRoutes(KINDS.tenmatsu, [{ listPath: "list_denied.html", listUrlMarker: "list_denied.html" }]);
  const shinsei = withRoutes(KINDS.tenmatsu, [
    {
      id: "shinsei",
      listPath: "shinsei_list.html?workflowId=4",
      listUrlMarker: "shinsei_list.html",
      detailUrlMarker: "shinsei_detail.html",
      unverified: true,
    },
  ]);
  return await runSurvey({
    page,
    tenant,
    home: `${server!.url}/menu_workflow.html`,
    deptCode: null,
    log: (line) => lines.push(line),
    progress: () => undefined,
    deadlineAt: Date.now() + 60_000,
    probes: [
      { kind: denied, route: denied.routes[0] },
      { kind: shinsei, route: shinsei.routes[0] },
    ],
    timing: { navigation: QUICK, detail: { frameWaitMs: 3_000, reopenWaitMs: 2_000, popupWaitMs: 1_000 } },
  });
}

describe.skipIf(!browser)("画面の下見（通し）", () => {
  it("★伝票の値・伝票No.・楽楽精算のURLが報告に混ざらない", async () => {
    const page = await browser!.newPage();
    const report = await survey(page);
    const text = `${JSON.stringify(report)}\n${formatSurveyReport(report)}`;
    for (const secret of ["SECRET_CELL", "SECRET_VALUE", "マル秘", "極秘", "TE00077001", "架空 一郎", "架空建材"]) {
      expect(text, `${secret} が報告に入っている`).not.toContain(secret);
    }
    // テナントの場所（ホスト）も入らない
    expect(text).not.toContain(new URL(server!.url).host);
    await page.close();
  }, 60_000);

  it("画面の作り（メニュー・見出し・部品）は分かる形で入る", async () => {
    const page = await browser!.newPage();
    const report = await survey(page);
    const text = formatSurveyReport(report);

    // 上部のタブ（「閲覧」が無いことも分かる）
    expect(report.menus.some((m) => m.text === "ワークフロー")).toBe(true);
    expect(report.menus.some((m) => m.text === "閲覧")).toBe(false);
    // 押したのは許可した文字だけ
    expect(report.clicked).toEqual(["ワークフロー", "押印の申請"]);
    // 押した先に出るサブタブ
    expect(report.afterWorkflow.some((m) => m.text.includes("行為の申請"))).toBe(true);
    // 種類ごとの「一覧」の候補（隠れているものも、何に隠されているかまで分かる）
    const tenmatsu = report.lists.find((g) => g.kind === "tenmatsu");
    expect(tenmatsu?.candidates.length).toBeGreaterThan(0);

    // 一覧を開いてみた結果
    const denied = report.probes[0];
    expect(denied.outcome).toBe("LIST_NOT_PERMITTED");
    const shinsei = report.probes[1];
    expect(shinsei.outcome).toBe("ok");
    expect(shinsei.headers).toContain("伝票No.");
    expect(shinsei.headers).toContain("状態");
    expect(shinsei.rowCount).toBe(2);
    expect(shinsei.pageFeedCount).toBe(1);
    expect(shinsei.detailLinkPath).toContain("shinsei_detail.html");
    // 伝票No.の値は残さず、キー名だけにする
    expect(shinsei.detailLinkPath).toContain("eDenpyoNo=…");
    expect(shinsei.detailLinkPath).toContain("workflowId=4");

    // 伝票画面の部品（未確認の経路なので1件だけ開いて数える）
    const detail = report.details[0];
    expect(detail.selectors.find((s) => s.selector === "button.accesskeyPrint")?.total).toBe(1);
    expect(detail.selectors.find((s) => s.selector === 'span[onclick*="downloadFileData"]')).toEqual({
      selector: 'span[onclick*="downloadFileData"]',
      total: 5,
      visible: 2,
    });
    expect(detail.labels).toContain("申請日");

    expect(text).toContain("# 楽楽精算の画面の下見");
    expect(text).toContain("## 一覧を直接開いてみた結果");
    await page.close();
  }, 60_000);
});

describe("下見が触ってよい範囲", () => {
  const source = readFileSync(join(process.cwd(), "lib", "rakuraku", "survey.ts"), "utf8");

  it("★押してよいのはタブの切り替え2つだけ", () => {
    expect(clickAllowed("ワークフロー")).toBe(true);
    expect(clickAllowed("押印の申請")).toBe(true);
    for (const text of ["一覧", "印刷", "承認", "申請", "検索"]) expect(clickAllowed(text)).toBe(false);
  });

  it("★下見は印刷も承認履歴も読み込まない（取得の道具を持ち込まない）", () => {
    expect(source).not.toContain('from "./download"');
    expect(source).not.toContain('from "./approval-log"');
  });

  it("★クリックは1か所だけ（許可リストを通らない押し方を増やさない）", () => {
    const clicks = source.split(".click(").length - 1;
    expect(clicks).toBe(1);
  });
});

describe("報告に入れてよい形に整える", () => {
  it("3桁以上の数字は伏せる", () => {
    expect(redact("伝票 TE00077001 は 110,000 円")).toBe("伝票 TE# は #,# 円");
    expect(redact("2026/09/10")).toBe("#/09/10");
    expect(redact("a".repeat(100), 10)).toHaveLength(10);
  });

  it("★問い合わせ部分は白名簿だけ値を残す（伝票No.は名前だけ）", () => {
    expect(pickQuery("?workflowId=4&refId=4")).toBe("?workflowId=4&refId=4");
    expect(pickQuery("?eDenpyoNo=TE00077001")).toBe("?eDenpyoNo=…");
    expect(pickQuery("")).toBe("");
  });

  it("★テナントの場所を落とし、外を指す URL は場所も書かない", () => {
    const login = "https://tenant.example.test/abcd/login/init";
    expect(relativeTenantPath("https://tenant.example.test/abcd/login/list?workflowId=4", login)).toBe(
      "list?workflowId=4",
    );
    expect(relativeTenantPath("https://other.example.test/x", login)).toBe("(テナント外)");
    expect(relativeTenantPath("あ", login)).toBe("(URLを読めません)");
  });
});
