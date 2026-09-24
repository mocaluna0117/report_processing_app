import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/account/gate";
import { StoreUnavailableError } from "@/lib/account/kv";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";
import { type SessionState, clearedCookies, issueSession, readSession } from "@/lib/account/session";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Folio のログインの門番。顧客の個人情報を扱うので、URL を知っているだけでは使えないようにする。
 *
 * ★一人ずつのアカウント（2026-09-24）。判断は lib/account/gate.ts（純関数）にまとめてあり、ここは薄く呼ぶだけ。
 *   - 手元の開発で FOLIO_ACCOUNTS が無ければ全部通す（今までどおり）
 *   - Vercel の上で設定が足りなければ、開いたままにせず 503 にする（fail closed）
 *   - 旧合言葉のクッキーは、APP_PASSWORD が残っている間だけ通す（切り替えの間、1人目が使い続けられるように）
 * ★Basic 認証のヘッダーは受け付けない。
 */
export async function proxy(request: NextRequest) {
  const config = currentAuthConfig();
  const { pathname, search } = request.nextUrl;
  const nowSec = Math.floor(Date.now() / 1000);
  const secure = request.nextUrl.protocol === "https:";

  const session: SessionState =
    config.kind === "accounts"
      ? await readSession(request.cookies.get(SESSION_COOKIE)?.value, config, nowSec)
      : { kind: "none", hadToken: false };

  const decision = await decideAccess(
    { config, pathname, search, session, nowSec },
    async (id) => {
      if (config.kind !== "accounts") return null;
      try {
        return await accountStoreFor(config).get(id);
      } catch (e) {
        if (e instanceof StoreUnavailableError) return "unavailable";
        throw e;
      }
    },
  );

  if (decision.kind === "pass") {
    const response = NextResponse.next();
    // 確かめ直したら、確かめた時刻を新しくした印を出し直す（期限は延ばさない）
    if (decision.reissue && config.kind === "accounts" && session.kind === "account") {
      const { cookies } = issueSession({
        record: decision.reissue,
        secret: config.secret,
        secure,
        nowSec,
        keepExp: session.claims.exp,
      });
      for (const cookie of cookies) response.cookies.set(cookie);
      response.headers.set("Cache-Control", "private, no-store");
    }
    return response;
  }

  const response =
    decision.kind === "redirect"
      ? NextResponse.redirect(new URL(decision.location, request.url))
      : new NextResponse(decision.body, {
          status: decision.status,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
  if (decision.clear) for (const cookie of clearedCookies(secure)) response.cookies.set(cookie);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  // 静的アセット以外のすべて (ページと /api) を保護する
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|pdf.worker.min.mjs).*)"],
};
