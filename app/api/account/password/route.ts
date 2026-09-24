import type { NextRequest } from "next/server";
import { handleChangePassword } from "@/lib/account/change-password";
import { sessionOf } from "@/lib/account/current";
import { originInputOf } from "@/lib/account/origin";
import { createKeyedLimiter } from "@/lib/account/rate-limit";
import { isHttps, redirectWith } from "@/lib/account/respond";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 1人1分に10回まで（今のパスワードの当てずっぽうを止める。失敗は Redis でも数える） */
const limiter = createKeyedLimiter({ windowMs: 60_000, max: 10 });

/** パスワードを決める・変える（普通のフォームの POST。303 で /account か行き先へ） */
export async function POST(request: NextRequest) {
  const config = currentAuthConfig();
  if (config.kind !== "accounts") return redirectWith(request, "/account");
  const session = sessionOf(request, config);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectWith(request, "/account?error=busy");
  }
  const result = await handleChangePassword(
    {
      config,
      origin: originInputOf(request),
      claims: session.kind === "account" ? session.claims : null,
      form: { current: form.get("current"), password: form.get("password"), confirm: form.get("confirm"), next: form.get("next") },
      secure: isHttps(request),
      nowMs: Date.now(),
    },
    { store: accountStoreFor(config), limiter },
  );
  return redirectWith(request, result.location, result.cookies);
}
