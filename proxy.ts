import { NextResponse, type NextRequest } from "next/server";

/**
 * 簡易パスワード保護 (HTTP Basic認証)。
 * 顧客の個人情報を扱うアプリなので、デプロイ先のURLを知っているだけでは使えないようにする。
 * 環境変数 APP_PASSWORD が設定されているときだけ有効 (ローカル開発では未設定でそのまま使える)。
 * ユーザー名は APP_USER (省略時 "user")。ブラウザが認証ダイアログを出し、以降のリクエスト
 * (ページ・/api 両方) に自動で付与する。
 */
export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const expectedUser = process.env.APP_USER || "user";
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (sep > 0 && user === expectedUser && pass === password) {
        return NextResponse.next();
      }
    } catch {
      // 不正なbase64は未認証として扱う
    }
  }

  return new NextResponse("認証が必要です", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Folio", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

export const config = {
  // 静的アセット以外のすべて (ページと /api) を保護する
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|pdf.worker.min.mjs).*)"],
};
