import type { NextRequest } from "next/server";
import { handleLogin } from "@/lib/account/login";
import { originInputOf } from "@/lib/account/origin";
import { createKeyedLimiter } from "@/lib/account/rate-limit";
import { clientIp, isHttps, redirectWith } from "@/lib/account/respond";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";
import { safeNextPath } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redis の手前で止める回数（同じ場所から1分に20回まで。Redis の無料枠を使い切らせない） */
const limiter = createKeyedLimiter({ windowMs: 60_000, max: 20 });

/**
 * ログインフォームの送信先（一人ずつのアカウント。lib/account/login.ts）。
 * 画面遷移を伴う POST → 303 にすることで、ブラウザの「パスワードを保存しますか」が出るようにしている。
 * ★前の共通の合言葉（APP_PASSWORD）は、ログインにもクッキーにも使わない（2026-09-25 にやめた）。
 * ★入れたら、ほかの端末のログインは切れる（lib/account/login.ts。1つのアカウントで使える端末は1つ）。
 */
export async function POST(request: NextRequest) {
  const config = currentAuthConfig();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectWith(request, "/login?error=1");
  }
  // アカウントを使わない手元ではログイン自体が不要
  if (config.kind === "off") return redirectWith(request, safeNextPath(form.get("next")));
  if (config.kind === "broken") return redirectWith(request, "/login?error=broken");

  const result = await handleLogin(
    {
      config,
      // ★同じサイトから送られたかは handleLogin の最初で確かめる（login CSRF を防ぐ）
      origin: originInputOf(request),
      form: { id: form.get("user"), password: form.get("password"), next: form.get("next") },
      ip: clientIp(request),
      secure: isHttps(request),
      nowMs: Date.now(),
    },
    { store: accountStoreFor(config), limiter },
  );
  return redirectWith(request, result.location, result.cookies);
}
