import "server-only";
import { launchBrowser } from "./browser";
import type { TenantConfig } from "./config";
import { landingCounters } from "./landing";
import { log } from "./log";
import { autoLoginOnce } from "./login";
import { SESSION_TTL_MS, seal } from "./session";
import type { AttemptResult } from "./stored-login";
import { hasViewTab } from "./tabs";

export interface LoggedIn {
  sessionToken: string;
  expiresAt: number;
  viewTab: boolean;
}

/**
 * ブラウザを起こして楽楽精算に1回だけログインし、ログイン状態を封じて返す（ログインと登録の口で共通）。
 *
 * ★やり直さない。★ID とパスワードはこの中でだけ使い、記録しない（ログは数だけ）。
 * ★beforeSubmit は打つ直前に呼ばれる（lib/rakuraku/stored-login.ts が「送った」と書く）。
 * ★終わったら必ずブラウザを閉じる。ブラウザを起こせない（BROWSER_BUSY など）ときは例外のまま返す
 *   （楽楽精算に触る前なので、数えない）。
 */
export async function browserLogin(input: {
  tenant: TenantConfig;
  credentials: { userId: string; password: string };
  /** 封じた状態の持ち主（Folio の ID） */
  sub: string;
  budgetMs: number;
  started: number;
  beforeSubmit: () => Promise<boolean>;
}): Promise<AttemptResult<LoggedIn>> {
  const launched = await launchBrowser();
  try {
    const context = await launched.browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(10_000, input.budgetMs - (Date.now() - input.started)));

    const result = await autoLoginOnce(page, input.tenant, input.credentials, { beforeSubmit: input.beforeSubmit });
    const counters = result.markers ? landingCounters(result.markers) : {};
    if (result.code !== "OK") {
      log("login", { ok: false, code: result.code, ms_total: Date.now() - input.started, ...counters });
      return { code: result.code, message: result.message, submitted: result.submitted };
    }

    // ★このアカウントに「閲覧」タブがあるか（＝自部門検索を使えるか）。見るだけ（押さない）
    const viewTab = await hasViewTab(page);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const sessionToken = seal({
      state: JSON.stringify(await context.storageState()),
      // ★ログイン画面ではなく「着いた画面」を覚える（次回の状態確認に使う）
      home: result.homeUrl ?? input.tenant.loginUrl,
      viewTab,
      exp: expiresAt,
      sub: input.sub,
    });
    log("login", { ok: true, n_view_tab: viewTab ? 1 : 0, ms_total: Date.now() - input.started, ...counters });
    return { code: "OK", value: { sessionToken, expiresAt, viewTab } };
  } finally {
    await launched.close();
  }
}
