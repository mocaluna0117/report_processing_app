import "server-only";

/**
 * パスワードを変える（POST /api/account/password）。
 *
 * - 仮のパスワードで入った人（印の mc=1）: 今のパスワードは聞かない。仮と同じものは使わせない
 * - いつでも変える人: 今のパスワードを確かめる（違えば失敗として数える）
 * - 変えたら版（sv）を進める → ほかの端末は、次に画面を開いたとき（遅くとも5分以内）に切れる。この端末は新しい印を出す
 */
import type { AuthConfig } from "@/lib/account/config";
import { StoreUnavailableError } from "@/lib/account/kv";
import { type OriginInput, isSameOriginPost } from "@/lib/account/origin";
import { canonicalTemp, hashPassword, type ScryptParams, verifyPassword } from "@/lib/account/password";
import { type PasswordProblem, passwordProblemCodes } from "@/lib/account/policy";
import type { KeyedLimiter } from "@/lib/account/rate-limit";
import { nextVersion } from "@/lib/account/record";
import { type CookieSpec, clearedCookies, issueSession } from "@/lib/account/session";
import { passwordTooLong } from "@/lib/account/login";
import { type AccountStore, FAIL_MAX_ID, KEYS } from "@/lib/account/store";
import { type SessionClaims, keyedHash } from "@/lib/account/token";
import { safeNextPath } from "@/lib/auth";

export type ChangeError = "origin" | "current" | "policy" | "busy" | "locked" | "unavailable";

export interface ChangeInput {
  config: Extract<AuthConfig, { kind: "accounts" }>;
  origin: OriginInput;
  /** 署名を確かめた印（無ければ null） */
  claims: SessionClaims | null;
  form: { current: unknown; password: unknown; confirm: unknown; next: unknown };
  secure: boolean;
  nowMs: number;
}

export interface ChangeResult {
  location: string;
  cookies: CookieSpec[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

const back = (error: ChangeError, problems: PasswordProblem[] = [], next = "/"): ChangeResult => {
  const params = new URLSearchParams({ error });
  if (problems.length > 0) params.set("p", problems.join(","));
  if (next !== "/") params.set("next", next);
  return { location: `/account?${params.toString()}`, cookies: [] };
};

export async function handleChangePassword(
  input: ChangeInput,
  deps: { store: AccountStore; limiter: KeyedLimiter; scrypt?: ScryptParams },
): Promise<ChangeResult> {
  const next = safeNextPath(input.form.next);
  if (!isSameOriginPost(input.origin)) return back("origin", [], next);
  const { claims } = input;
  if (!claims) return { location: "/login?expired=1", cookies: clearedCookies(input.secure) };
  if (!deps.limiter.take(`pw:${claims.u}`, input.nowMs)) return back("busy", [], next);

  try {
    const record = await deps.store.get(claims.u);
    if (!record || record.disabled || record.sv !== claims.sv) {
      return { location: "/login?expired=1", cookies: clearedCookies(input.secure) };
    }
    const forced = claims.mc === 1;
    if (forced !== record.mustChange) return { location: "/login?expired=1", cookies: clearedCookies(input.secure) };

    const password = str(input.form.password);
    const confirm = str(input.form.confirm);
    const current = str(input.form.current);
    const failIdKey = KEYS.failId(keyedHash(input.config.secret, "fail-id", record.id));
    if (!forced) {
      // ★今のパスワードの当てずっぽうも、ログインと同じ数え方で止める（照合する前に数える）
      const [count] = await deps.store.reserveAttempt([failIdKey]);
      if (count > FAIL_MAX_ID) return back("locked", [], next);
      const ok = current.length > 0 && !passwordTooLong(current) && (await verifyPassword(current, record.hash));
      if (!ok) return back("current", [], next);
      await deps.store.clearFailures(failIdKey);
    }
    const problems = passwordProblemCodes({ password, confirm, loginId: record.id, current: forced ? null : current });
    // ★仮のパスワードと同じものは使わせない（仮は平文で持っていないので、ハッシュで比べる）
    if (forced && (await verifyPassword(canonicalTemp(password), record.hash))) problems.push("same");
    if (problems.length > 0) return back("policy", problems, next);

    const hash = await hashPassword(password, deps.scrypt);
    const now = input.nowMs;
    let written = false;
    const updated = await deps.store.update(record.id, (r) => {
      written = r.sv === claims.sv;
      return written ? { ...r, hash, mustChange: false, tempExpiresAt: null, sv: nextVersion(r, now), passwordChangedAt: now } : null;
    });
    if (!updated.ok || !written) return back("busy", [], next);
    const { cookies } = issueSession({
      record: updated.record,
      secret: input.config.secret,
      secure: input.secure,
      nowSec: Math.floor(now / 1000),
    });
    // 仮のパスワードの人は、行きたかった画面へ。いつでも変えた人は、変えたと出す
    return { location: forced ? next : "/account?done=1", cookies };
  } catch (e) {
    if (e instanceof StoreUnavailableError) return back("unavailable", [], next);
    throw e;
  }
}
