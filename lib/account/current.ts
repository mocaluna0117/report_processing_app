/**
 * API のルートが、自分でもログインを確かめる（proxy だけに頼らない）。★Redis は使わない（署名と期限だけ）。
 * 止めた・パスワードを変えたのは、proxy の確かめ直し（5分ごと）で届く。
 * ★proxy からも読むので server-only は付けない。
 */
import type { AuthConfig } from "@/lib/account/config";
import { readCookie, currentAuthConfig } from "@/lib/account/runtime";
import { type SessionState, readSession } from "@/lib/account/session";
import { BROKEN_TEXT, UNAUTHORIZED_TEXT } from "@/lib/account/gate";
import { SESSION_COOKIE } from "@/lib/auth";

export type SignedIn =
  | { ok: true; /** アカウントのログインID（旧合言葉・アカウントを使わない手元では null） */ id: string | null }
  | { ok: false; response: Response };

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

export async function sessionOf(request: Request, config: Extract<AuthConfig, { kind: "accounts" }>): Promise<SessionState> {
  return readSession(readCookie(request.headers.get("cookie"), SESSION_COOKIE), config, Math.floor(Date.now() / 1000));
}

export async function requireSignedIn(request: Request, config: AuthConfig = currentAuthConfig()): Promise<SignedIn> {
  if (config.kind === "off") return { ok: true, id: null };
  if (config.kind === "broken") return { ok: false, response: text(503, BROKEN_TEXT) };
  const session = await sessionOf(request, config);
  if (session.kind === "legacy") return { ok: true, id: null };
  // ★仮のパスワードの人は、パスワードを決めるまで使えない
  if (session.kind === "account" && session.claims.mc === 0) return { ok: true, id: session.claims.u };
  return { ok: false, response: text(401, UNAUTHORIZED_TEXT) };
}
