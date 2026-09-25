import { NextResponse } from "next/server";
import type { BrowserContextOptions } from "playwright-core";
import { launchBrowser } from "@/lib/rakuraku/browser";
import { currentDepartment, departmentsBody, listDepartments } from "@/lib/rakuraku/department";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { log } from "@/lib/rakuraku/log";
import { openHome } from "@/lib/rakuraku/navigation";
import { reseal, unseal } from "@/lib/rakuraku/session";
import { toErrorEvent } from "@/lib/rakuraku/stream";
import { requireSignedIn } from "@/lib/account/current";
import { sessionSubjectOf } from "@/lib/rakuraku/subject";

/**
 * このアカウントで**実際に選べる部門**を楽楽精算から読む。
 *
 * ★ 部門名を設定に持たない理由がここにある。アカウントによって選べるものが違うので、
 *   決め打ちにすると「選べない部門を指定したまま、別部門の伝票を黙って取る」ことが起こる。
 * ★ **プルダウンが無いのは失敗ではない**（「閲覧」タブが無いアカウントには切り替えが無い）。
 *   hasDepartmentSelect を添えて成功として返し、画面はそのまま「部門を指定せず」に進める。
 *   部門を指定したのにプルダウンが無いとき（取得時）は、今までどおり DEPT_SELECT_MISSING で止める。
 * ★ **ここでは開き直し（やり直し）をしない。** 実際に起きた失敗は Chromium の処理そのものが
 *   消えたときのもので、同じブラウザで開き直しても成功しようがない。作り直すと空き枠の取り合い
 *   （最大30秒待ち）と立ち上げ直しで持ち時間（60秒）を使い切り、原因になったメモリも余計に使う。
 *   やり直しはブラウザ側（lib/tenmatsu/local/departments.ts）で行う。新しい呼び出しになるので
 *   空き枠もメモリも取り直しになり、しかも順番に1回ずつなので重ならない。
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const json = (body: unknown) =>
  NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  // ★proxy だけに頼らず、ここでもログインを確かめる（署名と期限。仮のパスワードの人は通さない）
  const signed = await requireSignedIn(request);
  if (!signed.ok) return signed.response;
  const started = Date.now();
  let tenant;
  try {
    assertSameOrigin(request);
    tenant = assertEnabled();
  } catch (e) {
    const { type: _type, ...body } = toErrorEvent(e);
    return json({ ok: false, ...body });
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
    // ★持ち主（Folio のアカウント）が違う札は断る（ほかの人のログイン状態を使わせない）
    const session = unseal(sessionToken, sessionSubjectOf(signed.id));
    launched = await launchBrowser();
    const context = await launched.browser.newContext({
      storageState: JSON.parse(session.state) as BrowserContextOptions["storageState"],
    });
    const page = await context.newPage();
    // ★ ログイン画面の URL を開いてはいけない。ログイン済みでもフォームが出るので、
    //   「パスワード欄があるか」で見ると必ず「切れている」と誤判定する。
    //   openHome はテナントの中かを確かめ、繋がらなければ TENANT_UNREACHABLE（やり直してよい失敗）、
    //   ログインが切れていれば SESSION_EXPIRED にしてくれる。
    await openHome(page, tenant, session.home);

    const list = await listDepartments(page);
    const body = departmentsBody(list, list === null ? null : await currentDepartment(page));
    log("list", {
      ok: true,
      n_departments: body.departments.length,
      n_dept_select: body.hasDepartmentSelect ? 1 : 0,
      ms_total: Date.now() - started,
    });
    return json({
      ok: true,
      ...body,
      // ★期限と覚えた経路は引き継ぐ (以前はここで期限が延び、覚えた分が落ちていた)
      sessionToken: reseal(session, JSON.stringify(await context.storageState())),
      expiresAt: session.exp,
      totalMs: Date.now() - started,
    });
  } catch (e) {
    // ★失敗の種類（やり直してよいか・ログインし直しが要るか）もそのまま返す。
    //   ブラウザ側はこれを見て、一時的な失敗のときだけ1回やり直す
    const { type: _type, ...body } = toErrorEvent(e);
    log("list", { ok: false, code: body.code });
    return json({ ok: false, ...body });
  } finally {
    await launched?.close();
  }
}
