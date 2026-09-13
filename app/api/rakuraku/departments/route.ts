import { NextResponse } from "next/server";
import type { BrowserContextOptions } from "playwright-core";
import { launchBrowser } from "@/lib/rakuraku/browser";
import { currentDepartment, listDepartments } from "@/lib/rakuraku/department";
import { DEPT_SELECT_MISSING_TEXT, RakurakuError } from "@/lib/rakuraku/errors";
import { assertTenantUrl } from "@/lib/rakuraku/config";
import { GuardError, assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { isLoginScreen } from "@/lib/rakuraku/login";
import { log } from "@/lib/rakuraku/log";
import { SessionError, seal, unseal } from "@/lib/rakuraku/session";

/**
 * このアカウントで**実際に選べる部門**を楽楽精算から読む。
 *
 * ★ 部門名を設定に持たない理由がここにある。アカウントによって選べるものが違うので、
 *   決め打ちにすると「選べない部門を指定したまま、別部門の伝票を黙って取る」ことが起こる。
 * ★ プルダウンが無いのは画面が変わったからではなく、**権限が無い**ことが多い。
 *   その区別が付く符号（DEPT_SELECT_MISSING）で返す。
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const json = (body: unknown) =>
  NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const started = Date.now();
  let tenant;
  try {
    assertSameOrigin(request);
    tenant = assertEnabled();
  } catch (e) {
    const code = e instanceof GuardError ? e.code : "INTERNAL";
    return json({ ok: false, code, message: (e as Error).message });
  }

  let sessionToken = "";
  try {
    const body = (await request.json()) as { sessionToken?: unknown };
    if (typeof body.sessionToken === "string") sessionToken = body.sessionToken;
  } catch {
    /* 下で弾く */
  }
  if (!sessionToken) return json({ ok: false, code: "BAD_REQUEST", message: "sessionToken が要ります" });

  let launched;
  try {
    const { state, home } = unseal(sessionToken);
    // ★ ログイン画面の URL を開いてはいけない。ログイン済みでもフォームが出るので、
    //   「パスワード欄があるか」で見ると必ず「切れている」と誤判定する。
    const target = assertTenantUrl(home, tenant).toString();
    launched = await launchBrowser();
    const context = await launched.browser.newContext({
      storageState: JSON.parse(state) as BrowserContextOptions["storageState"],
    });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: "load", timeout: 30_000 });

    if (await isLoginScreen(page)) {
      log("list", { ok: false, code: "SESSION_EXPIRED" });
      return json({
        ok: false,
        code: "SESSION_EXPIRED",
        message: "ログインし直してください",
      });
    }

    const departments = await listDepartments(page);
    if (!departments) {
      log("list", { ok: false, code: "DEPT_SELECT_MISSING" });
      return json({ ok: false, code: "DEPT_SELECT_MISSING", message: DEPT_SELECT_MISSING_TEXT });
    }

    const current = await currentDepartment(page);
    log("list", { ok: true, n_departments: departments.length, ms_total: Date.now() - started });
    return json({
      ok: true,
      departments,
      current,
      sessionToken: seal({ state: JSON.stringify(await context.storageState()), home }),
      totalMs: Date.now() - started,
    });
  } catch (e) {
    const code = e instanceof RakurakuError ? e.code : e instanceof SessionError ? "SESSION_EXPIRED" : "INTERNAL";
    log("list", { ok: false, code });
    return json({
      ok: false,
      code,
      message: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "失敗しました",
    });
  } finally {
    await launched?.close();
  }
}
