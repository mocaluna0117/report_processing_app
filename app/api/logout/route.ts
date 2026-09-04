import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SIGNED_IN_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

/** ログアウト (共有端末で使い終わったとき)。クッキーを消してログイン画面へ戻す */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  for (const name of [SESSION_COOKIE, SIGNED_IN_COOKIE]) {
    response.cookies.set({ name, value: "", path: "/", maxAge: 0 });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
