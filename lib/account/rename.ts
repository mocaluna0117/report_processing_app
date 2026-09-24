import "server-only";

/**
 * 自分の表示名を変える（POST /api/account/name）。
 * ★表示名を変えても、ログインは切らない（版は変えない）。この端末の右上はすぐ変わる
 *   （1つのアカウントで使える端末は1つなので、ほかの端末は考えなくてよい）。
 * ★仮のパスワードの人は、パスワードを決めるまで使えない（門番が通さない）。
 */
import type { AuthConfig } from "@/lib/account/config";
import { StoreUnavailableError } from "@/lib/account/kv";
import { type OriginInput, isSameOriginPost } from "@/lib/account/origin";
import { displayNameProblemCode } from "@/lib/account/policy";
import { type CookieSpec, clearedCookies, issueSession } from "@/lib/account/session";
import type { AccountStore } from "@/lib/account/store";
import type { SessionClaims } from "@/lib/account/token";

export interface RenameInput {
  config: Extract<AuthConfig, { kind: "accounts" }>;
  origin: OriginInput;
  claims: SessionClaims | null;
  form: { name: unknown };
  secure: boolean;
  nowMs: number;
}

export async function handleRename(
  input: RenameInput,
  deps: { store: AccountStore },
): Promise<{ location: string; cookies: CookieSpec[] }> {
  const back = (error: string) => ({ location: `/account?error=${error}`, cookies: [] as CookieSpec[] });
  if (!isSameOriginPost(input.origin)) return back("origin");
  const { claims } = input;
  if (!claims || claims.mc === 1) return { location: "/login?expired=1", cookies: clearedCookies(input.secure) };

  const raw = typeof input.form.name === "string" ? input.form.name : "";
  const problem = displayNameProblemCode(raw);
  if (problem) return back(problem);
  const name = raw.trim();

  try {
    const updated = await deps.store.update(claims.u, (r) =>
      r.disabled || r.sv !== claims.sv ? null : r.name === name ? null : { ...r, name },
    );
    if (!updated.ok) return { location: "/login?expired=1", cookies: clearedCookies(input.secure) };
    const record = updated.record;
    if (record.disabled || record.sv !== claims.sv) {
      return { location: "/login?expired=1", cookies: clearedCookies(input.secure) };
    }
    // ★右上の名前がすぐ変わるよう、表示用の印を出し直す（ログインの期限は延ばさない）
    const { cookies } = issueSession({
      record,
      secret: input.config.secret,
      secure: input.secure,
      nowSec: Math.floor(input.nowMs / 1000),
      keepExp: claims.exp,
    });
    return { location: "/account?done=name", cookies };
  } catch (e) {
    if (e instanceof StoreUnavailableError) return back("unavailable");
    throw e;
  }
}
