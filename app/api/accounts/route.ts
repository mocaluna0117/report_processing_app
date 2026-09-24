import { NextResponse, type NextRequest } from "next/server";
import { handleAccountsRequest } from "@/lib/account/admin";
import { sessionOf } from "@/lib/account/current";
import { originInputOf } from "@/lib/account/origin";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** アカウントの管理（管理者だけ。毎回 Redis で確かめる） */
async function handle(request: NextRequest, method: "GET" | "POST") {
  const config = currentAuthConfig();
  if (config.kind !== "accounts") {
    return NextResponse.json({ ok: false, message: "この環境ではアカウントを使っていません" }, { status: 404 });
  }
  const session = await sessionOf(request, config);
  let body: unknown = null;
  if (method === "POST") body = await request.json().catch(() => null);
  const result = await handleAccountsRequest(
    {
      config,
      method,
      origin: originInputOf(request),
      claims: session.kind === "account" ? session.claims : null,
      body,
      nowMs: Date.now(),
    },
    { store: accountStoreFor(config) },
  );
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

export const GET = (request: NextRequest) => handle(request, "GET");
export const POST = (request: NextRequest) => handle(request, "POST");
