import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openApprovalLog, readFinalApprovedAt } from "@/lib/rakuraku/approval-log";
import type { TenantConfig } from "@/lib/rakuraku/config";
import { type DetailTiming, openDetail, readDetailFields, waitForDetailReady } from "@/lib/rakuraku/detail";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { readDetailRecord } from "@/lib/rakuraku/fetch-one";
import { contentFrame } from "@/lib/rakuraku/frames";
import { KINDS, type RakurakuKind } from "@/lib/rakuraku/kinds";
import { hasTimePart } from "@/lib/rakuraku/parse/datetime";
import { parseLabeledField, parseStaffNames } from "@/lib/rakuraku/parse/fields";
import { pickLabeledValue } from "@/lib/rakuraku/parse/tables";
import { readFrameTables } from "@/lib/rakuraku/tables";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 期待値は移植元の検証 (tenmatsu-dl/smoke_test.py「実構造」「開き直し」「専決決裁書」「捺印決裁書」) から写した。
// すべて架空の画面。PJコードは公開用に 99 で始まる架空の値へ置き換えてある
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** 検証用に待ち時間を縮める（本番は 20秒・10秒・8秒・8秒） */
const QUICK: DetailTiming = { frameWaitMs: 3_000, reopenWaitMs: 2_000, popupWaitMs: 2_000, readyWaitMs: 2_000 };
const tenant = (): TenantConfig => ({ loginUrl: `${server!.url}/` });
const url = (path: string) => `${server!.url}/${path}`;

let lines: string[] = [];
const log = (line: string) => lines.push(line);
beforeEach(() => {
  lines = [];
});

/** 伝票画面の目印をテスト用の画面に向けた種類 */
function withMarker(base: RakurakuKind, marker = "detail_structure.html", detail: Partial<RakurakuKind["detail"]> = {}): RakurakuKind {
  return { ...base, list: { ...base.list, detailUrlMarker: marker }, detail: { ...base.detail, ...detail } };
}

async function open(path: string): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(url(path), { waitUntil: "load" });
  return page;
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

const flag = (page: Page | import("playwright-core").Frame, name: string) =>
  page.evaluate((n) => (window as unknown as Record<string, unknown>)[n], name);

describe.skipIf(!browser)("画面の表を読む", () => {
  it("★見えている表だけ読む（閉じているダイアログの表は含まない）", async () => {
    const page = await open("detail_structure.html");
    const tables = await readFrameTables(page.mainFrame());
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.some((t) => t.rows.flat().join(" ").includes("差戻し"))).toBe(false);
    await page.close();
  });

  it("★&nbsp; だけのセルは空文字になる", async () => {
    const page = await open("detail_structure.html");
    const route = (await readFrameTables(page.mainFrame())).find((t) => t.cls?.includes("d_shonin_route"));
    expect(route?.rows.at(-1)).toEqual(["", "", "", ""]);
    await page.close();
  });

  it("ラベルの完全一致を優先し、1行に2組並ぶ形でも値が取れる", async () => {
    const page = await open("detail_structure.html");
    const tables = await readFrameTables(page.mainFrame());
    expect(pickLabeledValue(tables, "申請日")).toBe("2026/09/04 17:51:38");
    expect(pickLabeledValue(tables, "支払予定日")).toBe("2026/10/31");
    expect(pickLabeledValue(tables, "存在しないラベル")).toBeNull();
    await page.close();
  });
});

describe.skipIf(!browser)("伝票画面から項目を読む", () => {
  it("★顛末書: 申請日は秒まで・「どこで」は全文・PJコードは見出しから", async () => {
    const page = await open("detail_structure.html");
    const fields = await readDetailFields(page.mainFrame(), KINDS.tenmatsu);
    expect(fields).toEqual({
      shinsei_date: "2026/09/04 17:51:38",
      where: "注文受注物件：架空台1丁目A号棟 施主名：架空 太郎 監督：架空 一郎/営業：架空 二郎",
      pj: "9901230101",
    });
    expect(parseStaffNames(fields.where)).toEqual({ supervisor: "架空 一郎", sales_rep: "架空 二郎" });
    await page.close();
  });

  it("PJコードの見出しが無くても「どこで」のすぐ下の行から拾える", async () => {
    const page = await open("detail_structure.html");
    const { pj: _pj, ...labels } = KINDS.tenmatsu.detail.labels;
    const fields = await readDetailFields(page.mainFrame(), withMarker(KINDS.tenmatsu, "x", { labels }));
    expect(fields.pj).toBe("9901230101");
    await page.close();
  });

  it("「どこで」を読まない設定なら、どこでもPJも読まない", async () => {
    const page = await open("detail_structure.html");
    const fields = await readDetailFields(page.mainFrame(), withMarker(KINDS.tenmatsu, "x", { labels: { shinsei_date: "申請日", pj: "PJコード" } }));
    expect(fields).toEqual({ shinsei_date: "2026/09/04 17:51:38" });
    await page.close();
  });

  it("★「どこで」が空の伝票でもPJコードは読み、読めなかった「どこで」は入れない", async () => {
    const page = await open("detail_no_where.html");
    const fields = await readDetailFields(page.mainFrame(), KINDS.tenmatsu);
    expect(fields.pj).toBe("9901230101");
    expect("where" in fields).toBe(false);
    await page.close();
  });

  it("★専決決裁書: 表題・支払先・決裁申請額・内容を読み、どこで・PJは読まない", async () => {
    const page = await open("senketsu_detail.html");
    const fields = await readDetailFields(page.mainFrame(), KINDS.senketsu);
    expect(fields.shinsei_date).toBe("2026/09/04 17:51:38");
    expect(fields.title).toBe("外壁補修工事の発注");
    expect(fields.payee).toBe("架空塗装");
    expect(fields.amount).toBe("352,000 円");
    expect(fields.content).toContain("物件名：架空台2丁目B号棟");
    expect(Object.keys(fields).sort()).toEqual(["amount", "content", "payee", "shinsei_date", "title"]);
    expect(parseLabeledField(fields.content, "物件名")).toBe("架空台2丁目B号棟");
    await page.close();
  });

  it("★捺印決裁書: 内容・専決決裁書№・備考を読み、支払先・金額は読まない（専決決裁書から写す）", async () => {
    const page = await open("natsuin_detail.html");
    const fields = await readDetailFields(page.mainFrame(), KINDS.natsuin);
    expect(fields).toEqual({
      shinsei_date: "2026/09/05 10:20:30",
      content: "外壁補修工事の捺印依頼",
      senketsu_no: "2267",
      remarks: "物件情報 物件名：架空邸 施主名：架空 太郎 引渡日：2026-04-28",
    });
    expect(parseLabeledField(fields.remarks, "物件名")).toBe("架空邸");
    await page.close();
  });

  it("★表が遅れて描かれる画面は、描かれるまで待ってから読む（待たないと申請日が空になる）", async () => {
    const page = await open("slow_detail.html");
    expect(await readDetailFields(page.mainFrame(), KINDS.tenmatsu)).toEqual({});
    const ready = await waitForDetailReady(page, page.mainFrame(), KINDS.tenmatsu, 3_000);
    expect(await readDetailFields(ready, KINDS.tenmatsu)).toEqual({ shinsei_date: "2026/09/05 10:20:30" });
    await page.close();
  });
});

describe.skipIf(!browser)("承認履歴から最終承認日を読む", () => {
  it("★いちばん新しい承認の日付を採る（承認ルートの日付・差戻し・支払予定日・空欄は採らない）", async () => {
    const page = await open("detail_structure.html");
    const result = await readFinalApprovedAt(page, KINDS.tenmatsu, log);
    expect(result).toEqual({ value: "2026/09/06 13:45", opened: true });
    expect(hasTimePart(result.value)).toBe(true);
    // onclick の無いボタンでも、役割（button）と文字で拾って押せている
    expect(await flag(page, "__shoninLogOpened")).toBe(true);
    // ★ダイアログの「閉じる」は押していない
    expect(await flag(page, "__shoninLogCloseClicked")).toBe(false);
    await page.close();
  });

  it("★承認履歴を開いたままだと「印刷」が押せない → 伝票画面を開き直せば押せる", async () => {
    const page = await open("top_frameset.html");
    const kind = withMarker(KINDS.tenmatsu);
    const href = url("detail_structure.html");
    const frame = await openDetail(page, kind, tenant(), "TE00009002", href, { log, timing: QUICK });
    await readFinalApprovedAt(page, kind, log);
    const blocked = await frame
      .locator("button.accesskeyPrint")
      .click({ timeout: 1_000 })
      .then(() => false)
      .catch(() => true);
    expect(blocked).toBe(true);

    const reopened = await openDetail(page, kind, tenant(), "TE00009002", href, { log, timing: QUICK });
    await reopened.locator("button.accesskeyPrint").click({ timeout: 1_000 });
    expect(await flag(reopened, "__printClicked")).toBe(true);
    await page.close();
  });

  it("「承認履歴」が無い画面では開かずに空欄（落ちない）", async () => {
    const page = await open("natsuin_detail.html");
    expect(await readFinalApprovedAt(page, KINDS.natsuin, log)).toEqual({ value: null, opened: false });
    expect(lines.join("\n")).toContain("「承認履歴」が見つからない");
    await page.close();
  });

  it("読まない設定なら開かない", async () => {
    const page = await open("detail_structure.html");
    const off = withMarker(KINDS.tenmatsu, "x", { readApprovalLog: false });
    expect(await readFinalApprovedAt(page, off, log)).toEqual({ value: null, opened: false });
    expect(await flag(page, "__shoninLogOpened")).toBe(false);
    await page.close();
  });

  it("承認履歴が iframe で開いても読める", async () => {
    const page = await open("list_empty.html");
    await page.setContent(
      '<button type="button" id="b">承認履歴</button><script>document.getElementById("b").onclick=function(){' +
        'var f=document.createElement("iframe");' +
        'f.srcdoc="<table><tr><th>承認者</th><th>日付</th></tr><tr><td>A</td><td>2026/09/07</td></tr></table>";' +
        "document.body.appendChild(f);};</script>",
    );
    expect((await readFinalApprovedAt(page, KINDS.tenmatsu, log)).value).toBe("2026/09/07");
    await page.close();
  });

  it("★承認履歴が別ウィンドウで開いても読め、開いた窓は閉じる", async () => {
    const page = await open("list_empty.html");
    await page.setContent(
      '<button type="button" id="b">承認履歴</button><script>document.getElementById("b").onclick=function(){' +
        'var w=window.open("","shoninlog");' +
        'w.document.write("<table><tr><th>日付</th></tr><tr><td>2026/09/09</td></tr></table>");};</script>',
    );
    const before = page.context().pages().length;
    expect((await readFinalApprovedAt(page, KINDS.tenmatsu, log)).value).toBe("2026/09/09");
    expect(page.context().pages()).toHaveLength(before);
    await page.close();
  });

  it("表でない作りでも、クリック後に増えた行から読む（差戻しの行は採らない）", async () => {
    const page = await open("list_empty.html");
    await page.setContent(
      '<p>支払予定日 2026/10/31</p><button type="button" id="b">承認履歴</button><script>document.getElementById("b").onclick=function(){' +
        'var u=document.createElement("ul");' +
        'u.innerHTML="<li>テスト 一郎 承認 2026/09/10</li><li>差戻し 2026/09/12</li>";' +
        "document.body.appendChild(u);};</script>",
    );
    expect((await readFinalApprovedAt(page, KINDS.tenmatsu, log, { waitMs: 800 })).value).toBe("2026/09/10");
    await page.close();
  });

  it("★隠れている同じ文字を先に掴まない（押せずに時間切れにならない）", async () => {
    const page = await open("list_empty.html");
    await page.setContent(
      '<span style="display:none">承認履歴</span><span id="b">承認履歴</span>' +
        '<script>document.getElementById("b").onclick=function(){' +
        'document.body.insertAdjacentHTML("beforeend","<table><tr><th>日付</th></tr><tr><td>2026/09/11 08:00</td></tr></table>");};</script>',
    );
    expect(await openApprovalLog(page.mainFrame(), KINDS.tenmatsu)).toBe(true);
    await page.setContent(
      '<span style="display:none">承認履歴</span><span id="b">承認履歴</span>' +
        '<script>document.getElementById("b").onclick=function(){' +
        'document.body.insertAdjacentHTML("beforeend","<table><tr><th>日付</th></tr><tr><td>2026/09/11 08:00</td></tr></table>");};</script>',
    );
    const started = Date.now();
    expect((await readFinalApprovedAt(page, KINDS.tenmatsu, log)).value).toBe("2026/09/11 08:00");
    expect(Date.now() - started).toBeLessThan(3_000);
    await page.close();
  });

  it("★押せなくても例外を投げず、「開いた」側に倒して返す（開き直させる）", async () => {
    const page = await open("list_empty.html");
    await page.setContent(
      '<button type="button" id="b">承認履歴</button>' +
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:9"></div>',
    );
    const quick = withMarker(KINDS.tenmatsu, "x", { approvalLogClickTimeoutMs: 500 });
    expect(await readFinalApprovedAt(page, quick, log)).toEqual({ value: null, opened: true });
    expect(lines.join("\n")).toContain("承認履歴を読めませんでした");
    await page.close();
  });

  it("★専決決裁書も同じ作りで読める", async () => {
    const page = await open("senketsu_detail.html");
    expect(await readFinalApprovedAt(page, KINDS.senketsu, log)).toEqual({ value: "2026/09/06 13:45", opened: true });
    await page.close();
  });
});

describe.skipIf(!browser)("伝票画面を開く", () => {
  const kind = withMarker(KINDS.tenmatsu);

  it("トップ（frameset）の中で伝票画面を開ける", async () => {
    const page = await open("top_frameset.html");
    const frame = await openDetail(page, kind, tenant(), "TE00009002", url("detail_structure.html"), { log, timing: QUICK });
    expect(frame.name()).toBe("main");
    expect((await readDetailFields(frame, kind)).shinsei_date).toBe("2026/09/04 17:51:38");
    await page.close();
  });

  it("★同じURLへ開き直したとき、新しい文書になるまで待つ（古い文書を返さない）", async () => {
    const page = await open("top_frameset.html");
    const first = await openDetail(page, kind, tenant(), "TE00009002", url("detail_structure.html"), { log, timing: QUICK });
    await first.evaluate(() => {
      (window as unknown as { __before_reopen: number }).__before_reopen = 1;
    });
    // 応答を 800ミリ秒待たせる＝この間ずっと古い文書のまま。待たない作りだと、ここで古い文書が返る
    const again = await openDetail(page, kind, tenant(), "TE00009002", url("detail_structure.html?delay=800"), {
      log,
      timing: QUICK,
    });
    expect(await flag(again, "__before_reopen")).toBeUndefined();
    expect((await readFrameTables(again)).length).toBeGreaterThan(0);
    await page.close();
  });

  it("★別ウィンドウで開いた伝票を元の画面で開き直し、窓は増やさない", async () => {
    const page = await open("detail_popup_list.html");
    const before = page.context().pages().length;
    const frame = await openDetail(page, kind, tenant(), "TE00009002", null, { log, timing: QUICK });
    expect(frame.url()).toContain("detail_structure.html");
    expect((await contentFrame(page)).url()).toContain("detail_structure.html");
    expect(page.context().pages()).toHaveLength(before);
    expect(lines.join("\n")).toContain("別ウィンドウで開いたので");
    await page.close();
  });

  it("伝票No.が文字リンクでない一覧でも、一覧で読んだURLから開ける", async () => {
    const page = await open("detail_icon_list.html");
    const frame = await openDetail(page, kind, tenant(), "TE00009002", url("detail_structure.html?no=2"), { log, timing: QUICK });
    expect(frame.url()).toContain("detail_structure.html");
    await page.close();
  });

  it("★伝票画面の目印に着かなければ DETAIL_NOT_FOUND（一覧のリンクが無いせいにしない）", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(
      openDetail(page, withMarker(KINDS.tenmatsu, "決して現れない目印"), tenant(), "TE00009002", url("detail_structure.html"), {
        log,
        timing: QUICK,
      }),
    );
    expect(error.code).toBe("DETAIL_NOT_FOUND");
    expect(error.message).toContain("伝票画面にたどり着けません");
    await page.close();
  });

  it("URLも文字リンクも無ければ DETAIL_NOT_FOUND", async () => {
    const page = await open("detail_icon_list.html");
    const error = await failure(openDetail(page, kind, tenant(), "TE00009002", null, { log, timing: QUICK }));
    expect(error.code).toBe("DETAIL_NOT_FOUND");
    expect(error.message).toContain("TE00009002");
    expect(error.message).toContain("一覧にリンクが見つかりません");
    await page.close();
  });

  it("★伝票画面へ行くつもりがログイン画面に戻されたら、待ち切らずに SESSION_EXPIRED", async () => {
    const page = await open("top_frameset.html");
    const started = Date.now();
    const error = await failure(
      openDetail(page, kind, tenant(), "TE00009002", url("login_again.html"), { log, timing: { ...QUICK, frameWaitMs: 20_000 } }),
    );
    expect(error.code).toBe("SESSION_EXPIRED");
    expect(Date.now() - started).toBeLessThan(10_000);
    await page.close();
  }, 30_000);

  it("★テナントの外を指す URL は開かない", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(openDetail(page, kind, tenant(), "TE00009002", "https://example.invalid/detail", { log, timing: QUICK }));
    expect(error.code).toBe("BAD_REQUEST");
    expect((await contentFrame(page)).url()).toContain("top_main.html");
    await page.close();
  });
});

describe.skipIf(!browser)("伝票1件の項目を読む（通し）", () => {
  const listKind = (): RakurakuKind => ({
    // 伝票画面の目印は2つの見本（detail_structure / detail_no_where）に共通の文字。一覧の名前には含まれない
    ...withMarker(KINDS.tenmatsu, "detail_"),
    listPath: "list_with_detail.html",
    listUrlMarker: "list_with_detail.html",
  });

  const run = (page: Page, request: { denpyoNo: string; href: string | null; deptCode: string | null }, stages: string[]) => ({
    page,
    tenant: tenant(),
    home: url("top_frameset.html"),
    kind: listKind(),
    request,
    listUrlFound: null,
    log,
    progress: (stage: string) => stages.push(stage),
    timing: {
      detail: QUICK,
      list: { requestIntervalMs: 0, nextPageWaitMs: 2_000 },
      navigation: { frameWaitMs: 3_000, reopenWaitMs: 2_000, listTableWaitMs: 1_000 },
    },
  });

  it("★項目と最終承認日を読み、承認履歴のあとは伝票画面を開き直して返す（印刷が押せる）", async () => {
    const page = await browser!.newPage();
    const stages: string[] = [];
    const record = await readDetailRecord(run(page, { denpyoNo: "TE00009002", href: url("detail_structure.html"), deptCode: "1900" }, stages));
    expect(record.fields).toEqual({
      shinsei_date: "2026/09/04 17:51:38",
      where: "注文受注物件：架空台1丁目A号棟 施主名：架空 太郎 監督：架空 一郎/営業：架空 二郎",
      pj: "9901230101",
      final_approved_at: "2026/09/06 13:45",
    });
    await record.frame.locator("button.accesskeyPrint").click({ timeout: 1_000 });
    expect(await flag(record.frame, "__printClicked")).toBe(true);
    // URL が分かっている伝票は、部門も一覧も触らない
    expect(stages).toEqual(["open", "detail", "approval-log"]);
    // ★進捗の行に氏名を出さない
    expect(lines.join("\n")).not.toContain("架空");
    expect(lines.join("\n")).toContain("伝票画面: 申請日 2026/09/04 17:51:38 / 最終承認日 2026/09/06 13:45 / PJ 取得 / 監督 取得 / 営業 取得");
    await page.context().close();
  });

  it("★伝票画面の URL が無い伝票は、一覧から探して開く", async () => {
    const page = await browser!.newPage();
    const stages: string[] = [];
    const record = await readDetailRecord(run(page, { denpyoNo: "TE00009004", href: null, deptCode: "1900" }, stages));
    expect(record.fields.pj).toBe("9901230101");
    expect(record.href).toContain("detail_no_where.html");
    expect(stages).toEqual(["open", "department", "navigate", "detail", "approval-log"]);
    await page.context().close();
  });

  it("一覧にも無い伝票は DETAIL_NOT_FOUND（近い行を推測で開かない）", async () => {
    const page = await browser!.newPage();
    const error = await failure(readDetailRecord(run(page, { denpyoNo: "TE00009999", href: null, deptCode: "1900" }, [])));
    expect(error.code).toBe("DETAIL_NOT_FOUND");
    await page.context().close();
  });

  it("★ログインが切れていたら SESSION_EXPIRED", async () => {
    const page = await browser!.newPage();
    const error = await failure(
      readDetailRecord({ ...run(page, { denpyoNo: "TE00009002", href: url("detail_structure.html"), deptCode: "1900" }, []), home: url("login_again.html") }),
    );
    expect(error.code).toBe("SESSION_EXPIRED");
    await page.context().close();
  });
});
