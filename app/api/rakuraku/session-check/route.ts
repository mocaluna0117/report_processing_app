import { NextResponse } from "next/server";
import type { BrowserContextOptions } from "playwright-core";
import { launchBrowser } from "@/lib/rakuraku/browser";
import { assertTenantUrl } from "@/lib/rakuraku/config";
import { GuardError, assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { isLoginScreen } from "@/lib/rakuraku/login";
import { log } from "@/lib/rakuraku/log";
import { SessionError, seal, unseal } from "@/lib/rakuraku/session";

/**
 * 預けた `sessionToken` で、まだログイン状態が生きているかを確かめる。
 *
 * これが**移行のいちばん大事な関門**。Vercel は呼び出しごとに別の場所・別の
 * 出口アドレスになりうるので、楽楽精算がセッションを接続元に紐づけていると、
 * 伝票ごとにログインし直すことになり、アカウントロックの危険が跳ね上がる。
 * ログインとは別の呼び出しで通ることを確かめる必要がある。
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const started = Date.now();
  let tenant;
  try {
    assertSameOrigin(request);
    tenant = assertEnabled();
  } catch (e) {
    const code = e instanceof GuardError ? e.code : "INTERNAL";
    return NextResponse.json({ ok: false, code, message: (e as Error).message }, { headers: { "Cache-Control": "no-store" } });
  }

  let sessionToken = "";
  try {
    const body = (await request.json()) as { sessionToken?: unknown };
    if (typeof body.sessionToken === "string") sessionToken = body.sessionToken;
  } catch {
    /* 下で弾く */
  }
  if (!sessionToken) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "sessionToken が要ります" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let launched;
  try {
    const { state, home } = unseal(sessionToken);
    // ★ ログイン画面の URL を開いてはいけない。ログイン済みでもフォームが出るので、
    //   「パスワード欄があるか」で見ると必ず「切れている」と誤判定する。
    const target = assertTenantUrl(home, tenant).toString();
    launched = await launchBrowser();
    const context = await launched.browser.newContext({
      acceptDownloads: true,
      storageState: JSON.parse(state) as BrowserContextOptions["storageState"],
    });
    const page = await context.newPage();

    const t0 = Date.now();
    await page.goto(target, { waitUntil: "load", timeout: 30_000 });
    const navMs = Date.now() - t0;

    // 何が持ち回れたのかの手がかり（中身は出さず、数だけ）
    const restored = JSON.parse(state) as { cookies?: unknown[] };
    const cookieCount = Array.isArray(restored.cookies) ? restored.cookies.length : 0;

    const onLoginScreen = await isLoginScreen(page);
    const title = await page.title().catch(() => "");
    const frameCount = page.frames().length;

    // クッキーは入れ替わることがあるので、最新のものを返す
    const refreshed = seal({ state: JSON.stringify(await context.storageState()), home });

    log("login", { ok: !onLoginScreen, ms_nav: navMs, n_frames: frameCount });
    return NextResponse.json(
      {
        ok: !onLoginScreen,
        stillSignedIn: !onLoginScreen,
        title,
        frameCount,
        finalPath: (() => {
          try {
            return new URL(page.url()).pathname;
          } catch {
            return "";
          }
        })(),
        navMs,
        cookieCount,
        totalMs: Date.now() - started,
        sessionToken: refreshed,
        ...(onLoginScreen
          ? {
              message:
                "ログイン画面に戻されました（セッションが接続元に紐づいている可能性）",
            }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const code = e instanceof SessionError ? "SESSION_EXPIRED" : "INTERNAL";
    log("login", { ok: false, code });
    return NextResponse.json(
      { ok: false, code, message: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "失敗しました" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await launched?.close();
  }
}
