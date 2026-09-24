/**
 * ルートの返事にクッキーを付ける・リクエストから共通のものを読む。
 */
import { NextResponse } from "next/server";
import type { CookieSpec } from "@/lib/account/session";

export function redirectWith(request: Request, location: string, cookies: CookieSpec[] = []): NextResponse {
  const response = NextResponse.redirect(new URL(location, request.url), 303);
  for (const cookie of cookies) response.cookies.set(cookie);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const isHttps = (request: Request) => new URL(request.url).protocol === "https:";

/** 送り主の IP（Vercel は x-forwarded-for の先頭。キー名にはハッシュだけを使う） */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "").trim() || "unknown";
}
