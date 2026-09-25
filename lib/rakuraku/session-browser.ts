import "server-only";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { type LaunchedBrowser, launchBrowser } from "./browser";
import { RakurakuError } from "./errors";
import type { KindId, RememberedRoute } from "./protocol";
import { type SessionPayload, reseal } from "./session";
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
  /** 一覧を開けた経路（種類ごと）。★次の呼び出しでその経路を先に試すために覚える */
  routes?: Partial<Record<KindId, RememberedRoute>>;
}

export async function withSessionPage(
  sink: EventSink,
  session: SessionPayload,
  run: (ctx: SessionPageRun) => Promise<SessionPageOutcome | void>,
): Promise<void> {
  // ★launchBrowser が失敗を分類して投げる（BROWSER_BUSY / BROWSER_LAUNCH_FAILED）
  const launched: LaunchedBrowser = await launchBrowser();
  // ★閉じるのは1回だけ（中断で閉じたあと、finally でもう一度閉じない）
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    await launched.close();
  };
  // すでに接続が切れていたら、楽楽精算には触らずに戻す（待っている人がいない）
  if (sink.signal.aborted) {
    await closeOnce();
    return;
  }

  let context: BrowserContext | null = null;
  const sendSession = async (routes = session.routes) => {
    if (!context) return;
    await sink.send({
      type: "session",
      // ★期限・持ち主・「閲覧」タブの判定は前のまま引き継ぐ（前は viewTab を落としていた）
      sessionToken: reseal(session, JSON.stringify(await context.storageState()), routes),
    });
  };

  try {
    context = await launched.browser.newContext({
      acceptDownloads: true,
      storageState: JSON.parse(session.state) as BrowserContextOptions["storageState"],
    });
    const page = await context.newPage();
    // ★中断でブラウザを閉じる仕掛けは、用意ができてから登録する。
    //   用意の前に登録すると、すでに切れている呼び出しでは stream.ts がその場で呼ぶので、
    //   newContext の前にブラウザが消え（意味の分からない失敗になり）、共有の空き枠も先に返ってしまう。
    sink.onAbort(() => void closeOnce());
    page.setDefaultTimeout(30_000);
    const outcome = await run({ page, session });
    await sendSession(outcome?.routes ? { ...session.routes, ...outcome.routes } : session.routes);
  } catch (e) {
    if (!(e instanceof RakurakuError && e.sessionLost)) await sendSession().catch(() => null);
    throw e;
  } finally {
    await closeOnce();
  }
}
