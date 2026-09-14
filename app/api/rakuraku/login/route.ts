import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { launchBrowser } from "@/lib/rakuraku/browser";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { GuardError, assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { autoLoginOnce } from "@/lib/rakuraku/login";
import { log } from "@/lib/rakuraku/log";
import { SESSION_TTL_MS, SessionError, seal } from "@/lib/rakuraku/session";

/**
 * 楽楽精算にログインし、その状態を封じた `sessionToken` を返す。
 *
 * ★ ログインは**利用者ごと**。各自のIDとパスワードを受け取り、その人のログイン状態を返す。
 * ★ ID とパスワードはこの関数の中だけで使い、**どこにも保存しない・記録しない**。
 * ★ 失敗しても自動でやり直さない（アカウントロックを避けるため）。
 *   短時間の連打も、この関数の手前で断る。
 */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** 予算。maxDuration より短くして、必ず答えを返せるようにする */
const BUDGET_MS = 90_000;
/** 失敗したあと、同じ人が続けて試せない時間（インスタンス内での best-effort） */
const COOLDOWN_MS = 60_000;
const cooldown = new Map<string, number>();

/**
 * 待ち時間を数える相手の見分け。
 *
 * ★ 利用者ごとに分けること。楽楽精算は**各自のIDとパスワード**でログインするので、
 *   誰かが打ち間違えたせいで別の人が待たされてはいけない。
 * ★ IDそのものは残さず、取り返せない形にしてから鍵にする。
 */
function cooldownKey(userId: string): string {
  return createHash("sha256").update(userId).digest("base64url").slice(0, 16);
}

function fail(code: string, message: string, status = 200) {
  return NextResponse.json({ ok: false, code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const started = Date.now();
  let tenant;
  try {
    assertSameOrigin(request);
    tenant = assertEnabled();
  } catch (e) {
    const code = e instanceof GuardError ? e.code : "INTERNAL";
    log("route", { ok: false, code });
    return fail(code, e instanceof Error ? e.message : String(e));
  }

  let body: { userId?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("BAD_REQUEST", "本文を読めませんでした");
  }
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!userId || !password) return fail("BAD_REQUEST", "ログインIDとパスワードが要ります");

  const key = cooldownKey(userId);
  const until = cooldown.get(key) ?? 0;
  if (until > Date.now()) {
    log("login", { ok: false, code: "LOGIN_COOLDOWN" });
    return fail(
      "LOGIN_COOLDOWN",
      `直前のログインに失敗しています。${Math.ceil((until - Date.now()) / 1000)}秒あけてから、入力を確かめてやり直してください`,
    );
  }

  let launched;
  try {
    launched = await launchBrowser();
    const context = await launched.browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(10_000, BUDGET_MS - (Date.now() - started)));

    const result = await autoLoginOnce(page, tenant, { userId, password });
    if (result.code !== "OK") {
      cooldown.set(key, Date.now() + COOLDOWN_MS);
      log("login", { ok: false, code: result.code, ms_total: Date.now() - started });
      return fail(result.code, result.message);
    }

    // 期限はここで決めて、ブラウザにも伝える（タブに控えを残すとき、期限切れを戻さないため）
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const sessionToken = seal({
      state: JSON.stringify(await context.storageState()),
      // ★ ログイン画面ではなく「着いた画面」を覚える（次回の状態確認に使う）
      home: result.homeUrl ?? tenant.loginUrl,
      exp: expiresAt,
    });
    log("login", { ok: true, ms_total: Date.now() - started });
    return NextResponse.json(
      { ok: true, sessionToken, expiresAt, totalMs: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const code = e instanceof RakurakuError ? e.code : e instanceof SessionError ? "SESSION_SECRET" : "INTERNAL";
    log("login", { ok: false, code, ms_total: Date.now() - started });
    // ★ 例外の中身に資格情報が混ざらないよう、1行目だけを短く返す
    return fail(code, e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "失敗しました");
  } finally {
    await launched?.close();
  }
}
