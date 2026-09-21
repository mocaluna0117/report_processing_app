import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantConfig } from "@/lib/rakuraku/config";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { contentFrame } from "@/lib/rakuraku/frames";
import { KINDS, type ListRoute, type RakurakuKind } from "@/lib/rakuraku/kinds";
import {
  type NavigationTiming,
  applyDepartment,
  findMenuCandidates,
  gotoList,
  openHome,
} from "@/lib/rakuraku/navigation";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { oneRoute } from "./rakuraku/helpers/kinds";
import { startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 期待値は移植元の検証 (tenmatsu-dl/smoke_test.py「メニュー」「メニュー多段」) から写した。すべて架空の画面
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** 検証用に待ち時間を縮める（本番は 20秒・10秒・8秒） */
const QUICK: NavigationTiming = { frameWaitMs: 3_000, reopenWaitMs: 2_000, listTableWaitMs: 1_000 };
const tenant = (): TenantConfig => ({ loginUrl: `${server!.url}/` });

let lines: string[] = [];
const log = (line: string) => lines.push(line);
beforeEach(() => {
  lines = [];
});

async function open(path: string): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(`${server!.url}/${path}`, { waitUntil: "load" });
  return page;
}

/** 失敗を受け取る。失敗しなければテストを落とす */
async function failure(promise: Promise<unknown>): Promise<RakurakuError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof RakurakuError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

/** 押された回数（全フレームの合計）。★押していないことも確かめるため */
async function clicks(page: Page): Promise<number> {
  let sum = 0;
  for (const frame of page.frames()) {
    sum += await frame
      .evaluate(() => (window as unknown as { __menuClicked?: number }).__menuClicked || 0)
      .catch(() => 0);
  }
  return sum;
}

/** 一覧のパスが分からない種類（メニューを押して開く）。一覧の目印はテスト用の一覧に向ける */
function menuKind(base: RakurakuKind, overrides: Partial<ListRoute> = {}): RakurakuKind {
  return oneRoute(base, { listPath: "", listUrlMarker: "menu_list_stub.html", ...overrides });
}

/** 一覧のパスが分かっている種類（直接開く） */
function directKind(path: string, marker: string): RakurakuKind {
  return oneRoute(KINDS.tenmatsu, { listPath: path, listUrlMarker: marker });
}

describe.skipIf(!browser)("メニュー: 一覧のURLが分からない種類は、メニューの文字を押して開く", () => {
  const kind = menuKind(KINDS.senketsu);

  it("★メニューの文字を押して一覧を開ける・押したのは1回だけ", async () => {
    const page = await open("menu_structure.html");
    const location = await gotoList(page, kind, tenant(), { log, timing: QUICK });
    expect(location.frame.url()).toContain("menu_list_stub.html");
    expect(location.empty).toBe(false);
    expect(await clicks(page)).toBe(1);
    // ★上部バーとサイドの同じリンクを2つと数えない（押せている＝1つに絞れた）
    expect(lines.join("\n")).not.toContain("1つに絞れませんでした");
    await page.close();
  });

  it("★見つけたURLを控え、2回目はメニューを押さずに直接開く", async () => {
    const first = await open("menu_structure.html");
    const found = await gotoList(first, kind, tenant(), { log, timing: QUICK });
    expect(found.foundUrl).toContain("menu_list_stub.html?workflowId=7");
    await first.close();

    const page = await open("menu_structure.html");
    const again = await gotoList(page, kind, tenant(), {
      log,
      remembered: { id: kind.routes[0].id, url: found.foundUrl ?? undefined },
      timing: QUICK,
    });
    expect(await clicks(page)).toBe(0);
    expect(again.frame.url()).toContain("menu_list_stub.html?workflowId=7");
    expect(again.foundUrl).toBeNull(); // 直接開いたときは覚え直さない
    await page.close();
  });

  it("★候補が複数なら押さずに止まる", async () => {
    const page = await open("menu_structure.html");
    const error = await failure(gotoList(page, menuKind(kind, { menuText: "決裁" }), tenant(), { log, timing: QUICK }));
    expect(error.code).toBe("MENU_AMBIGUOUS");
    expect(error.message).toContain("1つに絞れませんでした");
    expect(await clicks(page)).toBe(0);
    // 候補を出して、何と何で迷ったかが分かるようにする
    expect(lines.some((l) => l.includes("専決決裁書一覧"))).toBe(true);
    await page.close();
  });

  it("★href が同じ（#）で onclick が違うメニューを1つに潰さない", async () => {
    const page = await open("menu_structure.html");
    for (const frame of page.frames()) {
      if (frame.url().includes("menu_main.html")) {
        // 上部バーの「専決決裁書」は消す。完全一致でそちらが先に当たると不具合が隠れるため
        await frame.evaluate(() => {
          document.body.innerHTML = "";
        });
      }
      if (frame.url().includes("menu_side.html")) {
        await frame.evaluate(() => {
          document.body.innerHTML = "";
          for (const [text, href] of [
            ["専決決裁書申請", "menu_list_stub.html?a=1"],
            ["専決決裁書一覧", "menu_list_stub.html?a=2"],
          ]) {
            const a = document.createElement("a");
            a.setAttribute("href", "#"); // 行き先は href に無い
            a.setAttribute("onclick", `location=${JSON.stringify(href)}`);
            a.textContent = text;
            document.body.appendChild(a);
          }
        });
      }
    }
    const error = await failure(gotoList(page, kind, tenant(), { log, timing: QUICK }));
    expect(error.code).toBe("MENU_AMBIGUOUS");
    await page.close();
  });

  it("★メニューが無ければ、権限が無い可能性を理由に出す（設定の誤りだけを疑わせない）", async () => {
    const page = await open("menu_structure.html");
    const error = await failure(
      gotoList(page, menuKind(kind, { menuText: "存在しないメニュー" }), tenant(), { log, timing: QUICK }),
    );
    expect(error.code).toBe("MENU_NOT_FOUND");
    expect(error.message).toContain("閲覧権限が無いか");
    expect(error.message).toContain("存在しないメニュー");
    expect(error.message).not.toContain("config"); // Folio の利用者は設定ファイルを触れない
    await page.close();
  });

  it("探すだけでは押さない・同じ画面で2回探しても番号がずれない", async () => {
    const page = await open("menu_structure.html");
    const a = await findMenuCandidates(page, "専決決裁書");
    const b = await findMenuCandidates(page, "専決決裁書");
    expect(a.map((c) => c.index)).toEqual(b.map((c) => c.index));
    expect(a).toHaveLength(1);
    expect(await clicks(page)).toBe(0);
    await page.close();
  });
});

describe.skipIf(!browser)("メニュー多段: ワークフロー → 押印の申請 → 捺印決裁書の「一覧」", () => {
  const kind = menuKind(KINDS.natsuin);

  it("★3段たどって捺印決裁書の一覧を開ける・押したのは3回だけ（隠れたタブの「一覧」を押さない）", async () => {
    const page = await open("menu_steps.html");
    const location = await gotoList(page, kind, tenant(), { log, timing: QUICK });
    expect(location.frame.url()).toContain("wf=natsuin");
    // 押した回数は遷移で消えるので、行き先のURLに持たせてある
    expect(location.frame.url()).toContain("clicks=3");
    expect(location.foundUrl).toContain("wf=natsuin");
    await page.close();
  });

  it("★2回目はメニューをたどらず直接開く", async () => {
    const first = await open("menu_steps.html");
    const found = await gotoList(first, kind, tenant(), { log, timing: QUICK });
    await first.close();

    const page = await open("menu_steps.html");
    await gotoList(page, kind, tenant(), {
      log,
      remembered: { id: kind.routes[0].id, url: found.foundUrl ?? undefined },
      timing: QUICK,
    });
    expect(await clicks(page)).toBe(0);
    expect((await contentFrame(page)).url()).toContain("wf=natsuin");
    await page.close();
  });

  it("★一覧が別ウィンドウで開いても取り込み、開いた窓は閉じる", async () => {
    const page = await open("menu_steps.html");
    for (const frame of page.frames()) {
      await frame
        .evaluate(() => {
          (window as unknown as { __popup: boolean }).__popup = true;
        })
        .catch(() => null);
    }
    const before = page.context().pages().length;
    const location = await gotoList(page, kind, tenant(), { log, timing: QUICK });
    expect(location.frame.url()).toContain("wf=natsuin");
    expect(page.context().pages()).toHaveLength(before);
    expect(location.foundUrl).toContain("wf=natsuin");
    expect(lines.join("\n")).toContain("別ウィンドウで開いたので");
    await page.close();
  });

  it("★同じ文字が並ぶとき near が無ければ押さずに止まる", async () => {
    const page = await open("menu_steps.html");
    const loose = menuKind(kind, { menuSteps: [{ text: "ワークフロー" }, { text: "押印の申請" }, { text: "一覧" }] });
    const error = await failure(gotoList(page, loose, tenant(), { log, timing: QUICK }));
    expect(error.code).toBe("MENU_AMBIGUOUS");
    expect(await clicks(page)).toBe(2);
    await page.close();
  });
});

describe.skipIf(!browser)("一覧へ直接移動し、本当に一覧かを確かめる", () => {
  it("トップ（frameset）の中で一覧へ移動できる", async () => {
    const page = await open("top_frameset.html");
    const location = await gotoList(page, directKind("list_structure.html?workflowId=4", "list_structure.html"), tenant(), {
      log,
      timing: QUICK,
    });
    expect(location.frame.url()).toContain("list_structure.html");
    expect(location.frame.name()).toBe("main");
    expect(location.empty).toBe(false);
    expect(location.foundUrl).toBeNull();
    await page.close();
  });

  it("★URLは合っているのに一覧の表が無ければ LIST_NOT_PERMITTED（移植元は着いたとみなしていた）", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(
      gotoList(page, directKind("list_denied.html", "list_denied.html"), tenant(), { log, timing: QUICK }),
    );
    expect(error.code).toBe("LIST_NOT_PERMITTED");
    expect(error.message).toContain("顛末書の一覧を開けません");
    expect(error.message).toContain("閲覧権限");
    await page.close();
  });

  it("★「0件中」の一覧は権限の問題ではなく、伝票が1件も無いとみなす", async () => {
    const page = await open("top_frameset.html");
    const location = await gotoList(page, directKind("list_empty.html", "list_empty.html"), tenant(), {
      log,
      timing: QUICK,
    });
    expect(location.empty).toBe(true);
    await page.close();
  });

  it("一覧の画面そのものに着かなければ LIST_NOT_FOUND（画面ごと開き直してから諦める）", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(
      gotoList(page, directKind("menu_list_stub.html", "決して現れない目印"), tenant(), { log, timing: QUICK }),
    );
    expect(error.code).toBe("LIST_NOT_FOUND");
    expect(lines.join("\n")).toContain("直接開きます");
    await page.close();
  }, 30_000);

  it("★移動中にログイン画面へ戻されたら、待ち切らずに SESSION_EXPIRED", async () => {
    const page = await open("top_frameset.html");
    const started = Date.now();
    const error = await failure(
      gotoList(page, directKind("login_again.html?to=list", "決して現れない目印"), tenant(), {
        log,
        timing: { ...QUICK, frameWaitMs: 20_000 },
      }),
    );
    expect(error.code).toBe("SESSION_EXPIRED");
    expect(error.sessionLost).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    await page.close();
  }, 30_000);

  it("★テナントの外を指す URL は開かない（覚えていた URL でも）", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(
      gotoList(page, menuKind(KINDS.senketsu), tenant(), {
        log,
        remembered: { id: "jibumon", url: "https://example.invalid/list" },
        timing: QUICK,
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(page.url()).toContain("top_frameset.html");
    await page.close();
  });
});

describe.skipIf(!browser)("トップを開く", () => {
  it("ログインが生きていれば何も言わない", async () => {
    const page = await browser!.newPage();
    await openHome(page, tenant(), `${server!.url}/top_frameset.html`);
    expect(page.url()).toContain("top_frameset.html");
    await page.close();
  });

  it("★ログイン画面が出たら SESSION_EXPIRED（ログインし直さない）", async () => {
    const page = await browser!.newPage();
    const error = await failure(openHome(page, tenant(), `${server!.url}/login_again.html`));
    expect(error.code).toBe("SESSION_EXPIRED");
    // 入力欄に何も入れていない
    expect(await page.locator('input[type="password"]').inputValue()).toBe("");
    await page.close();
  });

  it("★テナントの外は開かない", async () => {
    const page = await browser!.newPage();
    const error = await failure(openHome(page, tenant(), "https://example.invalid/top"));
    expect(error.code).toBe("BAD_REQUEST");
    expect(page.url()).toBe("about:blank");
    await page.close();
  });
});

describe.skipIf(!browser)("部門を目的のものにする（呼ぶ側が必ず分岐できる形で）", () => {
  const home = () => `${server!.url}/top_frameset.html`;

  it("すでにその部門なら、そう書いて進む", async () => {
    const page = await open("top_frameset.html");
    const department = await applyDepartment(page, "1900", { log, reopenUrl: home() });
    expect(department?.code).toBe("1900");
    expect(lines).toContain("  所属部門: 品質管理部(1900)");
    await page.close();
  });

  it("★切り替えたら、効いたことを確かめてから進む", async () => {
    const page = await open("top_frameset.html");
    const department = await applyDepartment(page, "1800", { log, reopenUrl: home() });
    expect(department?.code).toBe("1800");
    expect(lines).toContain("  所属部門を切り替えました: アフターメンテナンス課(1800)");
    await page.close();
  });

  it("★選べない部門なら DEPT_NOT_AVAILABLE と、選べるものを返す", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(applyDepartment(page, "9999", { log, reopenUrl: home() }));
    expect(error.code).toBe("DEPT_NOT_AVAILABLE");
    expect(error.available?.map((d) => d.code)).toEqual(["1800", "1900"]);
    expect(error.message).toContain("選べるのは アフターメンテナンス課(1800) / 品質管理部(1900)");
    await page.close();
  });

  it("★部門を指定したのにプルダウンが無ければ DEPT_SELECT_MISSING（黙って進まない）", async () => {
    const page = await open("dept-missing.html");
    const error = await failure(applyDepartment(page, "1900", { log }));
    expect(error.code).toBe("DEPT_SELECT_MISSING");
    await page.close();
  });

  it("部門の切り替えが無いアカウント（null）は、本当に無いことを確かめて進む", async () => {
    const page = await open("dept-missing.html");
    expect(await applyDepartment(page, null, { log })).toBeNull();
    expect(lines.join("\n")).toContain("部門の切り替えが無いアカウント");
    await page.close();
  });

  it("★選択肢が空のプルダウンがあるときは、部門を指定せずに進ませない（逃げ道の安全網）", async () => {
    const page = await open("dept-select-empty.html");
    const error = await failure(applyDepartment(page, null, { log }));
    expect(error.code).toBe("DEPT_NOT_AVAILABLE");
    expect(error.message).toContain("選択肢が空でした");
    await page.close();
  });

  it("★部門を選ばずに（null）来たのにプルダウンがあれば、選べるものを添えて止める", async () => {
    const page = await open("top_frameset.html");
    const error = await failure(applyDepartment(page, null, { log }));
    expect(error.code).toBe("DEPT_NOT_AVAILABLE");
    expect(error.available).toHaveLength(2);
    await page.close();
  });

  it("★選んでも楽楽精算が覚えていなければ DEPT_SWITCH_FAILED（別部門の伝票を取らない）", async () => {
    // 画面の中の表示だけが変わり、開き直すと元に戻る作り
    const page = await open("dept-select.html");
    const error = await failure(
      applyDepartment(page, "1800", { log, reopenUrl: `${server!.url}/dept-select.html`, requestStartWaitMs: 200 }),
    );
    expect(error.code).toBe("DEPT_SWITCH_FAILED");
    expect(error.message).toContain("品質管理部(1900)");
    await page.close();
  });
});
