import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantConfig } from "@/lib/rakuraku/config";
import { RakurakuError } from "@/lib/rakuraku/errors";
import {
  KINDS,
  type ListRoute,
  type RakurakuKind,
  ROUTE_LABELS,
  detailMarkerFor,
  resolveKind,
} from "@/lib/rakuraku/kinds";
import {
  type NavigationTiming,
  gotoList,
  orderRoutes,
  pinnedRoute,
  rememberedOf,
} from "@/lib/rakuraku/navigation";
import type { RouteHow } from "@/lib/rakuraku/protocol";
import { accountRouteText } from "@/lib/rakuraku/parse/route";
import { landingCounters, readLandingMarkers } from "@/lib/rakuraku/landing";
import { hasViewTab, isTabNamed } from "@/lib/rakuraku/tabs";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { type FixtureServer, startFixtureServer } from "./rakuraku/helpers/fixture-server";
import { withRoutes } from "./rakuraku/helpers/kinds";

/**
 * 一覧への経路の切り替え（閲覧＝自部門検索 → ワークフロー＝申請検索）。
 *
 * ★アカウントによって使える画面が違う（「閲覧」タブが無い人がいる）。開けなかったら次の経路へ移り、
 *   どの経路で開いたかを必ず返す（一覧に出る伝票の範囲が違うため）。
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

/** 検証用に待ち時間を縮める（本番は 20秒・10秒・8秒）。表を待つ時間は詰めすぎない */
const QUICK: NavigationTiming = { frameWaitMs: 3_000, reopenWaitMs: 2_000, listTableWaitMs: 4_000 };
const tenant = (): TenantConfig => ({ loginUrl: `${server!.url}/` });
const url = (path: string) => `${server!.url}/${path}`;

let lines: string[] = [];
const log = (line: string) => lines.push(line);
beforeEach(() => {
  lines = [];
});

async function open(path: string): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(url(path), { waitUntil: "load" });
  return page;
}

const failure = async (p: Promise<unknown>): Promise<RakurakuError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof RakurakuError) return e;
    throw e;
  }
  throw new Error("失敗するはずが成功しました");
};

/** 閲覧では開けず、ワークフローでは開ける種類（2人目のアカウントの再現） */
const twoRoutes = (): RakurakuKind =>
  withRoutes(KINDS.tenmatsu, [
    { listPath: "list_denied.html", listUrlMarker: "list_denied.html" },
    { listPath: "shinsei_list.html?workflowId=4", listUrlMarker: "shinsei_list.html", detailUrlMarker: "shinsei_detail.html" },
  ]);

interface Recorded {
  route: ListRoute;
  how: RouteHow;
}
const recorder = () => {
  const seen: Recorded[] = [];
  return { seen, onRoute: (route: ListRoute, how: RouteHow) => seen.push({ route, how }) };
};

describe.skipIf(!browser)("経路の切り替え", () => {
  it("★閲覧で開けなければワークフローへ切り替える", async () => {
    const page = await open("top_frameset.html");
    const { seen, onRoute } = recorder();
    const location = await gotoList(page, twoRoutes(), tenant(), { log, timing: QUICK, onRoute });
    expect(location.route.id).toBe("shinsei");
    expect(location.frame.url()).toContain("shinsei_list.html");
    expect(location.tried).toHaveLength(1);
    expect(location.tried[0].route.id).toBe("jibumon");
    expect(location.tried[0].code).toBe("LIST_NOT_PERMITTED");
    expect(seen).toEqual([{ route: location.route, how: "fallback" }]);
    expect(lines.join("\n")).toContain("へ切り替えます");
    await page.close();
  }, 30_000);

  it("★前に使えた経路を先に試す（切り替えの1往復を省く）", async () => {
    const page = await open("top_frameset.html");
    const { seen, onRoute } = recorder();
    const location = await gotoList(page, twoRoutes(), tenant(), {
      log,
      remembered: { id: "shinsei" },
      timing: QUICK,
      onRoute,
    });
    expect(location.route.id).toBe("shinsei");
    expect(location.tried).toEqual([]);
    expect(seen[0].how).toBe("remembered");
    expect(lines.join("\n")).not.toContain("へ切り替えます");
    await page.close();
  }, 30_000);

  it("★経路を固定したら、開けなくても他の経路を試さない", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(gotoList(page, twoRoutes(), tenant(), { log, pin: "jibumon", timing: QUICK }));
    expect(error.code).toBe("LIST_NOT_PERMITTED");
    expect(lines.join("\n")).not.toContain("ワークフロー");
    await page.close();
  }, 30_000);

  it("★どの経路でも開けなければ、試した経路を並べて理由にする", async () => {
    const page = await open("top_frameset.html");
    const denied = withRoutes(KINDS.tenmatsu, [
      { listPath: "list_denied.html", listUrlMarker: "list_denied.html" },
      { listPath: "list_denied.html", listUrlMarker: "list_denied.html" },
    ]);
    const error = await failure(gotoList(page, denied, tenant(), { log, timing: QUICK }));
    expect(error.code).toBe("LIST_NOT_PERMITTED");
    expect(error.message).toContain("どの経路でも開けませんでした");
    expect(error.message).toContain("閲覧（自部門検索）");
    expect(error.message).toContain("ワークフロー（申請検索）");
    await page.close();
  }, 30_000);

  it("★ログインが切れたときは切り替えずにそのまま返す", async () => {
    const page = await open("top_frameset.html");
    const kind = withRoutes(KINDS.tenmatsu, [
      { listPath: "login_again.html?to=list", listUrlMarker: "決して現れない目印" },
      { listPath: "shinsei_list.html", listUrlMarker: "shinsei_list.html" },
    ]);
    const error = await failure(gotoList(page, kind, tenant(), { log, timing: QUICK }));
    expect(error.code).toBe("SESSION_EXPIRED");
    expect(lines.join("\n")).not.toContain("へ切り替えます");
    await page.close();
  }, 30_000);

  it("★メニューを1つに絞れないときも切り替えない（画面が変わった疑いを隠さない）", async () => {
    const page = await open("menu_structure.html");
    const kind = withRoutes(KINDS.senketsu, [
      { listPath: "", listUrlMarker: "menu_list_stub.html", menuText: "決裁" },
      { listPath: "shinsei_list.html", listUrlMarker: "shinsei_list.html" },
    ]);
    const error = await failure(gotoList(page, kind, tenant(), { log, timing: QUICK }));
    expect(error.code).toBe("MENU_AMBIGUOUS");
    await page.close();
  }, 30_000);

  it("★切り替える前にトップを開き直す（エラーの画面からでも移動できる）", async () => {
    const page = await open("top_frameset.html");
    const location = await gotoList(page, twoRoutes(), tenant(), {
      log,
      home: url("top_frameset.html"),
      timing: QUICK,
    });
    expect(location.route.id).toBe("shinsei");
    await page.close();
  }, 30_000);

  it("★同じ目印を持つ一覧から別の一覧へ移れる（移動前のフレームを「着いた」と読み違えない）", async () => {
    const page = await open("top_frameset.html");
    const first = withRoutes(KINDS.natsuin, [
      { listPath: "shinsei_list.html?workflowId=8", listUrlMarker: "shinsei_list.html" },
    ]);
    const second = withRoutes(KINDS.senketsu, [
      { listPath: "shinsei_list.html?workflowId=3", listUrlMarker: "shinsei_list.html" },
    ]);
    await gotoList(page, first, tenant(), { log, timing: QUICK });
    const location = await gotoList(page, second, tenant(), { log, timing: QUICK });
    expect(location.frame.url()).toContain("workflowId=3");
    await page.close();
  }, 30_000);

  it("★設定どおりのメニューをたどってワークフロー側の一覧を開ける（URLが効かないときの保険）", async () => {
    const page = await open("menu_workflow.html");
    // ★メニューの手順は設定（KINDS）のものをそのまま使う。実画面の文字と合っているかを見張る
    const shinsei = KINDS.tenmatsu.routes[1];
    expect(shinsei.id).toBe("shinsei");
    const kind = withRoutes(KINDS.tenmatsu, [
      { ...shinsei, listPath: "", listUrlMarker: "shinsei_list.html" },
    ]);
    const location = await gotoList(page, kind, tenant(), { log, timing: QUICK });
    // 「一覧」は6つ以上並ぶが、同じ行の「顛末書」で選べている（専決決裁書の一覧へ行かない）
    expect(location.frame.url()).toContain("workflowId=4");
    expect(location.foundUrl).toContain("shinsei_list.html");
    expect(rememberedOf(location)).toEqual({ id: "shinsei", url: location.foundUrl });
    await page.close();
  }, 30_000);

  it("専決決裁書のメニューも、同じ画面から取り違えずに開ける", async () => {
    const page = await open("menu_workflow.html");
    const shinsei = KINDS.senketsu.routes[1];
    const kind = withRoutes(KINDS.senketsu, [
      { ...shinsei, listPath: "", listUrlMarker: "shinsei_list.html" },
    ]);
    const location = await gotoList(page, kind, tenant(), { log, timing: QUICK });
    expect(location.frame.url()).toContain("workflowId=3");
    await page.close();
  }, 30_000);
});

describe("★ログインしたあとに着いた画面の目印（数えるだけ。2026-09-25）", () => {
  it.runIf(browser)("ログイン後のトップ（frameset）: main のフレームと「ワークフロー」タブがあり、パスワード欄は無い", async () => {
    const page = await open("top_frameset.html");
    await page.waitForTimeout(300);
    expect(await readLandingMarkers(page)).toMatchObject({ mainFrame: true, workflowTab: true, passwordFields: 0, unreadableFrames: 0 });
    await page.close();
  }, 20_000);

  it.runIf(browser)("ログイン画面: パスワード欄があり、目印は無い", async () => {
    const page = await open("login_again.html");
    expect(await readLandingMarkers(page)).toMatchObject({ mainFrame: false, workflowTab: false, passwordFields: 1 });
    await page.close();
  }, 20_000);

  it.runIf(browser)("★お知らせだけの画面: パスワード欄が無くても、目印も無い（今の見分け方だと成功に見えてしまう画面）", async () => {
    const page = await open("list_denied.html");
    expect(await readLandingMarkers(page)).toMatchObject({ mainFrame: false, workflowTab: false, passwordFields: 0 });
    await page.close();
  }, 20_000);

  it("ログに出すのは n_ で始まる数だけ", () => {
    const counters = landingCounters({ frames: 3, mainFrame: true, workflowTab: false, passwordFields: 0, unreadableFrames: 1 });
    expect(counters).toEqual({ n_frames: 3, n_main_frame: 1, n_workflow_tab: 0, n_password_field: 0, n_unreadable_frame: 1 });
  });
});

describe("「閲覧」タブがあるアカウントかを見る", () => {
  it.runIf(browser)("★タブがあれば true（frameset の中のタブも見る）", async () => {
    const page = await open("menu_view.html");
    expect(await hasViewTab(page)).toBe(true);
    await page.close();
  }, 20_000);

  it.runIf(browser)("★タブが無ければ false（ワークフローだけのアカウント）", async () => {
    const page = await open("menu_workflow.html");
    expect(await hasViewTab(page)).toBe(false);
    await page.close();
  }, 20_000);

  it.runIf(browser)("★「閲覧権限がありません」のような文には反応しない", async () => {
    // 文言に反応すると、権限が無い画面を見て「権限がある」と読み違える
    const page = await open("list_denied.html");
    expect(await hasViewTab(page)).toBe(false);
    await page.close();
  }, 20_000);

  it("タブの名前は、字間や前後の空白を落としてから見比べる", () => {
    expect(isTabNamed(" 閲覧 ", "閲覧")).toBe(true);
    expect(isTabNamed("閲　覧", "閲覧")).toBe(true);
    expect(isTabNamed("閲覧権限がありません", "閲覧")).toBe(false);
    expect(isTabNamed("ワークフロー", "閲覧")).toBe(false);
  });
});

describe("ログインした時点で「どの経路から取るか」を伝える文", () => {
  it("「閲覧」タブがあるアカウントは、自部門検索から取ると伝える", () => {
    const text = accountRouteText("tenmatsu", true)!;
    expect(text).toContain("「閲覧」タブがあるので");
    expect(text).toContain(ROUTE_LABELS.jibumon);
    // 自部門検索は自分の申請分だけではないので、その断りは付けない
    expect(text).not.toContain("自分が申請した");
  });

  it("★「閲覧」タブが無いアカウントには、自分の申請分だけだと必ず伝える", () => {
    const text = accountRouteText("tenmatsu", false)!;
    expect(text).toContain("「閲覧」タブが無いので");
    expect(text).toContain(ROUTE_LABELS.shinsei);
    expect(text).toContain("自分が申請した顛末書だけ");
  });

  it("★捺印決裁書はもともとワークフローだけなので、タブがあっても申請検索と伝える", () => {
    const text = accountRouteText("natsuin", true)!;
    expect(text).toContain(ROUTE_LABELS.shinsei);
    expect(text).toContain("自分が申請した捺印決裁書だけ");
    expect(text).not.toContain(ROUTE_LABELS.jibumon);
  });

  it("分からないとき（古いサーバー）は何も言わない", () => {
    expect(accountRouteText("tenmatsu", null)).toBeNull();
  });
});

describe("経路の選び方（ブラウザ無し）", () => {
  it("固定が無ければ種類の順、前に使えた経路があればそれが先頭", () => {
    expect(orderRoutes(KINDS.tenmatsu, {}).map((r) => r.id)).toEqual(["jibumon", "shinsei"]);
    expect(orderRoutes(KINDS.tenmatsu, { remembered: { id: "shinsei" } }).map((r) => r.id)).toEqual([
      "shinsei",
      "jibumon",
    ]);
    // 知らない経路を覚えていても落とさない（種類の順に戻る）
    expect(orderRoutes(KINDS.natsuin, { remembered: { id: "jibumon" } }).map((r) => r.id)).toEqual(["shinsei"]);
  });

  it("★「閲覧」タブが無いアカウントは、申請検索を先に試す（開けない1回を省く）", () => {
    expect(orderRoutes(KINDS.tenmatsu, { viewTab: false }).map((r) => r.id)).toEqual(["shinsei", "jibumon"]);
    expect(orderRoutes(KINDS.senketsu, { viewTab: false }).map((r) => r.id)).toEqual(["shinsei", "jibumon"]);
    // 閲覧タブがあるアカウント・分からないときは今までどおり
    expect(orderRoutes(KINDS.tenmatsu, { viewTab: true }).map((r) => r.id)).toEqual(["jibumon", "shinsei"]);
    expect(orderRoutes(KINDS.tenmatsu, { viewTab: null }).map((r) => r.id)).toEqual(["jibumon", "shinsei"]);
  });

  it("★自部門検索は消さずに後ろへ回す（判定が外れても取れるはずの伝票を落とさない）", () => {
    const order = orderRoutes(KINDS.tenmatsu, { viewTab: false });
    expect(order.map((r) => r.id)).toContain("jibumon");
    expect(order).toHaveLength(KINDS.tenmatsu.routes.length);
  });

  it("★前に通った経路は、タブの判定より優先する（いちばん確かなので）", () => {
    expect(
      orderRoutes(KINDS.tenmatsu, { viewTab: false, remembered: { id: "jibumon" } }).map((r) => r.id),
    ).toEqual(["jibumon", "shinsei"]);
  });

  it("固定したらその経路だけを試す", () => {
    expect(orderRoutes(KINDS.tenmatsu, { pin: "shinsei" }).map((r) => r.id)).toEqual(["shinsei"]);
  });

  it("★その種類に無い経路を固定されたら断る（黙って自動に落とさない）", () => {
    expect(() => pinnedRoute(KINDS.natsuin, "jibumon")).toThrow(RakurakuError);
    try {
      pinnedRoute(KINDS.natsuin, "jibumon");
    } catch (e) {
      expect((e as RakurakuError).code).toBe("BAD_REQUEST");
      expect((e as RakurakuError).message).toContain("ワークフロー（申請検索）");
    }
  });

  it("★一覧から読んだ URL が別の経路の伝票画面でも開ける", () => {
    const shinsei = resolveKind(KINDS.tenmatsu, KINDS.tenmatsu.routes[1]);
    expect(detailMarkerFor(shinsei, "https://example.test/x/sapWorkflowDenpyoView/workflowDetailView?a=1")).toBe(
      "workflowDetailView",
    );
  });
});
