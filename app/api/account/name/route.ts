import type { NextRequest } from "next/server";
import { sessionOf } from "@/lib/account/current";
import { originInputOf } from "@/lib/account/origin";
import { handleRename } from "@/lib/account/rename";
import { isHttps, redirectWith } from "@/lib/account/respond";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 自分の表示名を変える（普通のフォームの POST。303 で /account へ） */
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
  const result = await handleRename(
    {
      config,
      origin: originInputOf(request),
      claims: session.kind === "account" ? session.claims : null,
      form: { name: form.get("name") },
      secure: isHttps(request),
      nowMs: Date.now(),
    },
    { store: accountStoreFor(config) },
  );
  return redirectWith(request, result.location, result.cookies);
}
