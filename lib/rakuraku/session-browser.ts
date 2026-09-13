import "server-only";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { type LaunchedBrowser, launchBrowser } from "./browser";
import { RakurakuError } from "./errors";
import type { KindId } from "./protocol";
import { type SessionPayload, seal } from "./session";
import type { EventSink } from "./stream";

/**
 * 封じたログイン状態でブラウザを起こし、処理を1つ走らせる（`/scan` `/fetch` で共通）。
 *
 * ★ログインはしない。状態が切れていたら処理の中で SESSION_EXPIRED になる。
 * ★終わったら（失敗しても・ブラウザが接続を切っても）必ずブラウザを閉じる。
 * ★ログインが生きている限り、新しいクッキーを封じ直して返す（入れ替わっていることがある）。
 *   期限は延ばさない。
 */
export interface SessionPageRun {
  page: Page;
  session: SessionPayload;
}

export interface SessionPageOutcome {
  /** メニューで見つけた一覧の URL が増えたときだけ返す */
  lists?: Partial<Record<KindId, string>>;
}

export async function withSessionPage(
  sink: EventSink,
  session: SessionPayload,
  run: (ctx: SessionPageRun) => Promise<SessionPageOutcome | void>,
): Promise<void> {
  let launched: LaunchedBrowser;
  try {
    launched = await launchBrowser();
  } catch (e) {
    throw new RakurakuError(
      "BROWSER_LAUNCH_FAILED",
      `ブラウザを起動できませんでした（${e instanceof Error ? e.name : "Error"}）`,
      { retryable: true },
    );
  }
  // ブラウザが接続を切ったら、待っている人はいないので楽楽精算の操作もすぐやめる
  sink.onAbort(() => void launched.close());

  let context: BrowserContext | null = null;
  const sendSession = async (lists = session.lists) => {
    if (!context) return;
    await sink.send({
      type: "session",
      sessionToken: seal({
        state: JSON.stringify(await context.storageState()),
        home: session.home,
        lists,
        exp: session.exp,
      }),
    });
  };

  try {
    context = await launched.browser.newContext({
      acceptDownloads: true,
      storageState: JSON.parse(session.state) as BrowserContextOptions["storageState"],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const outcome = await run({ page, session });
    await sendSession(outcome?.lists ? { ...session.lists, ...outcome.lists } : session.lists);
  } catch (e) {
    if (!(e instanceof RakurakuError && e.sessionLost)) await sendSession().catch(() => null);
    throw e;
  } finally {
    await launched.close();
  }
}
