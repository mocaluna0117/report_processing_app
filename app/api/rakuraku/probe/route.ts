import { NextResponse } from "next/server";
import { launchBrowser } from "@/lib/rakuraku/browser";
import { GuardError, assertEnabled } from "@/lib/rakuraku/guard";
import { log } from "@/lib/rakuraku/log";

/**
 * 移行の関門。**楽楽精算に Vercel から届くか**だけを確かめる。
 *
 * 見たいこと:
 *   ① Chromium が起動するか（バンドルが5GBに収まり、/tmp に展開できるか）
 *   ② ログイン画面に**到達できるか**（IP制限やSSOで弾かれないか）
 *   ③ どれくらい時間とメモリを食うか（1件30〜60秒の設計が成り立つか）
 *
 * ★ ログインは**しない**。資格情報を受け取らないので、アカウントロックの危険が無い。
 * ★ 500 を返さない。失敗も理由つきの JSON で返す（原因が分からないと関門にならない）。
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** ログイン画面らしさの判定。楽楽精算は frameset なので、全フレームを見る */
const PASSWORD_SELECTOR = 'input[type="password"]';

export async function GET(request: Request) {
  const started = Date.now();
  let tenant;
  try {
    tenant = assertEnabled();
  } catch (e) {
    const code = e instanceof GuardError ? e.code : "INTERNAL";
    log("route", { ok: false, code });
    return NextResponse.json(
      { ok: false, code, message: e instanceof Error ? e.message : String(e) },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const params = new URL(request.url).searchParams;
  const wantIp = params.get("ip") === "1";
  const wantPopup = params.get("popup") === "1";
  let launched;
  try {
    const t0 = Date.now();
    launched = await launchBrowser();
    const launchMs = Date.now() - t0;

    const context = await launched.browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    const t1 = Date.now();
    let navError: string | null = null;
    try {
      await page.goto(tenant.loginUrl, { waitUntil: "load", timeout: 30_000 });
    } catch (e) {
      navError = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e);
    }
    const navMs = Date.now() - t1;

    // frameset の中も含めてパスワード欄を探す
    let hasPasswordField = false;
    for (const frame of page.frames()) {
      const found = await frame
        .locator(PASSWORD_SELECTOR)
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false);
      if (found) {
        hasPasswordField = true;
        break;
      }
    }

    const title = await page.title().catch(() => "");
    const finalPath = (() => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return "";
      }
    })();
    const frameCount = page.frames().length;

    /**
     * ★ 別ウィンドウが開けるかを確かめる。
     *   伝票の本体PDFは「印刷」ボタンが別ウィンドウで開く経路でしか取れないのに、
     *   サーバー用の Chromium は --single-process で動いており、
     *   この指定は window.open を壊すことが知られている。
     *   楽楽精算に触らずに確かめられるので、ここで見ておく。
     */
    let popupOk: boolean | null = null;
    if (wantPopup) {
      await page.setContent('<a id="p" href="about:blank" target="_blank">open</a>');
      const [popup] = await Promise.all([
        page
          .context()
          .waitForEvent("page", { timeout: 8_000 })
          .catch(() => null),
        page.click("#p").catch(() => null),
      ]);
      popupOk = Boolean(popup);
      await popup?.close().catch(() => null);
    }

    let egressIp: string | null = null;
    if (wantIp) {
      egressIp = await page.request
        .get("https://api.ipify.org", { timeout: 10_000 })
        .then((r) => r.text())
        .catch(() => null);
    }

    const version = launched.browser.version();
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    log("route", {
      ok: !navError,
      ms_launch: launchMs,
      ms_nav: navMs,
      ms_total: Date.now() - started,
      n_frames: frameCount,
      n_rss_mb: rssMb,
    });

    return NextResponse.json(
      {
        ok: !navError && Boolean(title),
        chromium: version,
        region: process.env.VERCEL_REGION ?? "local",
        serverless: process.env.VERCEL === "1",
        launchMs,
        navMs,
        totalMs: Date.now() - started,
        title,
        finalPath,
        frameCount,
        hasPasswordField,
        rssMb,
        ...(navError ? { navError } : {}),
        ...(wantIp ? { egressIp } : {}),
        ...(wantPopup ? { popupOk } : {}),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    log("route", { ok: false, code: "BROWSER_LAUNCH_FAILED", ms_total: Date.now() - started });
    return NextResponse.json(
      {
        ok: false,
        code: "BROWSER_LAUNCH_FAILED",
        message: e instanceof Error ? e.message.split("\n").slice(0, 3).join(" / ").slice(0, 500) : String(e),
        totalMs: Date.now() - started,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await launched?.close();
  }
}
