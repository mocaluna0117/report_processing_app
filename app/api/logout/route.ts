import type { NextRequest } from "next/server";
import { isSameOriginPost, originInputOf } from "@/lib/account/origin";
import { isHttps, redirectWith } from "@/lib/account/respond";
import { clearedCookies } from "@/lib/account/session";

export const runtime = "nodejs";

/**
 * ログアウト（この端末だけ）。クッキーを消してログイン画面へ戻す。
 * ★ほかの端末は、ここでは切らない（1つのアカウントで使える端末は1つ。ほかの端末でログインすると、前の端末は切れる）。
 */
export async function POST(request: NextRequest) {
  // ★別のサイトから勝手にログアウトさせない（何も消さずに最初の画面へ）
  if (!isSameOriginPost(originInputOf(request))) return redirectWith(request, "/");
  return redirectWith(request, "/login?signed-out=1", clearedCookies(isHttps(request)));
}
