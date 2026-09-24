import type { NextRequest } from "next/server";
import { isSameOriginPost, originInputOf } from "@/lib/account/origin";
import { isHttps, redirectWith } from "@/lib/account/respond";
import { clearedCookies } from "@/lib/account/session";

export const runtime = "nodejs";

/**
 * ログアウト（この端末だけ）。クッキーを消してログイン画面へ戻す。
 * ほかの端末も切りたいときは、パスワードを変える（版が変わって5分以内に切れる）。
 */
export async function POST(request: NextRequest) {
  // ★別のサイトから勝手にログアウトさせない（何も消さずに最初の画面へ）
  if (!isSameOriginPost(originInputOf(request))) return redirectWith(request, "/");
  return redirectWith(request, "/login?signed-out=1", clearedCookies(isHttps(request)));
}
