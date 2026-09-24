import { NextResponse, type NextRequest } from "next/server";
import { isSameOriginPost, originInputOf } from "@/lib/account/origin";
import {
  SESSION_COOKIE,
  SIGNED_IN_COOKIE,
  createSessionToken,
  isValidCredentials,
  safeNextPath,
  sessionMaxAgeSeconds,
} from "@/lib/auth";

export const runtime = "nodejs";


/**
 * ログインフォームの送信先。
 * 画面遷移を伴うPOST → 303リダイレクトにすることで、
 * ブラウザの「パスワードを保存しますか」が出るようにしている。
 */
export async function POST(request: NextRequest) {
  // ★別のサイトのフォームから送られたログインは断る（他人を攻撃者の ID で入らせない）
  if (!isSameOriginPost(originInputOf(request))) {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", "origin");
    return NextResponse.redirect(login, 303);
  }
  const password = process.env.APP_PASSWORD;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }
  const next = safeNextPath(form.get("next"));

  // パスワード保護を使っていない環境ではログイン自体が不要
  if (!password) return NextResponse.redirect(new URL(next, request.url), 303);

  const expectedUser = process.env.APP_USER || "user";
  const user = String(form.get("user") ?? "");
  const input = String(form.get("password") ?? "");

  if (!isValidCredentials(user, input, expectedUser, password)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", "1");
    if (next !== "/") login.searchParams.set("next", next);
    return NextResponse.redirect(login, 303);
  }

  const maxAge = sessionMaxAgeSeconds();
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  const secure = new URL(request.url).protocol === "https:";
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await createSessionToken(expectedUser, password, maxAge),
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge,
  });
  // 画面に「ログアウト」を出すための印 (認証には使わないので httpOnly にしない)
  response.cookies.set({
    name: SIGNED_IN_COOKIE,
    value: "1",
    sameSite: "lax",
    secure,
    path: "/",
    maxAge,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
