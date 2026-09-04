import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, parseBasicAuth, isValidCredentials, verifySessionToken } from "@/lib/auth";

/**
 * 簡易パスワード保護。
 * 顧客の個人情報を扱うアプリなので、デプロイ先のURLを知っているだけでは使えないようにする。
 * 環境変数 APP_PASSWORD が設定されているときだけ有効 (ローカル開発では未設定でそのまま使える)。
 *
 * 認証はログインフォーム (/login) + 署名付きクッキー。
 * ブラウザ標準の Basic認証ダイアログはパスワードマネージャーが扱えず、
 * ブラウザを閉じると資格情報も消えてしまうため、通常のフォームにしている。
 * ただし Basic認証ヘッダーも受け付ける (スクリプトや vercel curl からの利用のため)。
 */
export async function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const expectedUser = process.env.APP_USER || "user";
  const { pathname } = request.nextUrl;

  // ログイン画面と、その送信先だけは通す (ここを止めるとログインできない)
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/api/logout") {
    return NextResponse.next();
  }

  if (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, expectedUser, password)) {
    return NextResponse.next();
  }

  const basic = parseBasicAuth(request.headers.get("authorization") ?? "");
  if (basic && isValidCredentials(basic.user, basic.password, expectedUser, password)) {
    return NextResponse.next();
  }

  // APIは画面遷移できないので、リダイレクトではなく401で返す
  if (pathname.startsWith("/api/")) {
    return new NextResponse("認証が必要です", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const login = new URL("/login", request.url);
  // ログイン後に元の画面へ戻す (パスだけを渡し、外部URLへは飛ばさない)
  const next = `${pathname}${request.nextUrl.search}`;
  if (next !== "/") login.searchParams.set("next", next);
  const response = NextResponse.redirect(login);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  // 静的アセット以外のすべて (ページと /api) を保護する
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|pdf.worker.min.mjs).*)"],
};
