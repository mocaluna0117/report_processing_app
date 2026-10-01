import "server-only";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import type { TenantConfig } from "./config";
import { type LaunchedBrowser, launchBrowser } from "./browser";
import { RakurakuError, isBrowserGoneError } from "./errors";
import { openHome } from "./navigation";
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

export interface SessionPageOptions {
  /**
   * 渡すと、処理の前にトップを開いてみて、**そこでブラウザが落ちたら1回だけ起こし直す**。
   *
   * ★2026-10-01、取得だけが開始から1秒以内に TARGET_CLOSED で止まった（楽楽精算ではなく、こちらの
   *   Chromium が消えていた）。この段階で楽楽精算へ送ったのは「クッキー付きでトップを開く」だけで、
   *   ログインも送信もしていないので、やり直してもアカウントのロックの決まりに触れない。
   * ★処理（run）の中でもトップを開き直す。1回余分に開くが、処理の側は今までと同じ手順のまま使える。
   */
  tenant?: TenantConfig;
}

/** close() を何度呼んでも1回だけ閉じる（空き枠を2回返さない） */
function closeOnceOf(launched: LaunchedBrowser): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => (closing ??= launched.close());
}

async function openSessionPage(
  launched: LaunchedBrowser,
  session: SessionPayload,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await launched.browser.newContext({
    acceptDownloads: true,
    storageState: JSON.parse(session.state) as BrowserContextOptions["storageState"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { context, page };
}

export async function withSessionPage(
  sink: EventSink,
  session: SessionPayload,
  run: (ctx: SessionPageRun) => Promise<SessionPageOutcome | void>,
  options: SessionPageOptions = {},
): Promise<void> {
  // ★launchBrowser が失敗を分類して投げる（BROWSER_BUSY / BROWSER_LAUNCH_FAILED）
  let launched: LaunchedBrowser = await launchBrowser();
  // ★閉じるのは1回だけ（中断で閉じたあと、finally でもう一度閉じない）。起こし直したら差し替える
  let closeOnce = closeOnceOf(launched);
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
    let page: Page;
    ({ context, page } = await openSessionPage(launched, session));
    // ★中断でブラウザを閉じる仕掛けは、用意ができてから登録する。
    //   用意の前に登録すると、すでに切れている呼び出しでは stream.ts がその場で呼ぶので、
    //   newContext の前にブラウザが消え（意味の分からない失敗になり）、共有の空き枠も先に返ってしまう。
    //   ★起こし直したあとも、そのとき開いているブラウザを閉じる（closeOnce を差し替えるので、呼ぶときに読む）
    sink.onAbort(() => void closeOnce());

    if (options.tenant) {
      try {
        await openHome(page, options.tenant, session.home);
      } catch (e) {
        if (!isBrowserGoneError(e) || sink.signal.aborted) throw e;
        sink.log("  （楽楽精算を開いていたブラウザが止まったので、起こし直してもう一度開きます）");
        const first = launched.diagnostics();
        sink.note({
          ...e.crash,
          n_relaunch: 1,
          n_first_launch_seq: first.n_launch_seq,
          ...(first.ms_browser_alive === undefined ? {} : { ms_first_browser_alive: first.ms_browser_alive }),
        });
        context = null;
        await closeOnce();
        if (sink.signal.aborted) throw e;
        launched = await launchBrowser();
        closeOnce = closeOnceOf(launched);
        // 起こしている間に接続が切れたら、新しいほうも閉じて戻す
        if (sink.signal.aborted) throw e;
        ({ context, page } = await openSessionPage(launched, session));
        // ★2回目も落ちたら、そのまま返す（3回目は無い）
        await openHome(page, options.tenant, session.home);
      }
    }

    const outcome = await run({ page, session });
    await sendSession(outcome?.routes ? { ...session.routes, ...outcome.routes } : session.routes);
  } catch (e) {
    if (!(e instanceof RakurakuError && e.sessionLost)) await sendSession().catch(() => null);
    throw e;
  } finally {
    // ★閉じる前に読む（こちらが閉じる前に切れたかどうか）
    sink.note(launched.diagnostics());
    await closeOnce();
  }
}
