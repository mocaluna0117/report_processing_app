import "server-only";

/**
 * ログイン（POST /api/login）。外とのやり取りは deps で受け取る。
 *
 * 順:
 * 1. 同じサイトから送られたか（login CSRF を防ぐ）
 * 2. 長さの上限
 * 3. メモリの回数制限（IP ごと。Redis の手前で止め、無料枠を使い切らせない）
 * 4. Redis の失敗回数（ID 5回・IP 30回で15分止める）
 * 5. scrypt で照合（ID が無いときもダミーで計算する。時間の差で ID の有無を悟らせない）
 * 6. 違ったら、最初の管理者のコードか確かめる（その ID のときだけ。ほかの ID の失敗では使い切られない）
 *
 * ★違ったときは「ログインIDかパスワードが違います」だけ（ID の有無・停止中を言い分けない）。
 *   停止中・仮のパスワードの期限切れは、パスワードが合っていたときだけ言う。
 */
import type { AuthConfig } from "@/lib/account/config";
import { parseBootstrap } from "@/lib/account/bootstrap";
import { StoreUnavailableError } from "@/lib/account/kv";
import type { LoginErrorCode } from "@/lib/account/messages";
import { type OriginInput, isSameOriginPost } from "@/lib/account/origin";
import { canonicalTemp, dummyHash, type ScryptParams, verifyPassword } from "@/lib/account/password";
import { normalizeLoginId } from "@/lib/account/policy";
import type { KeyedLimiter } from "@/lib/account/rate-limit";
import type { AccountRecord } from "@/lib/account/record";
import { type CookieSpec, MUST_CHANGE_MAX_SEC, issueSession } from "@/lib/account/session";
import { type AccountStore, FAIL_MAX_ID, FAIL_MAX_IP, KEYS } from "@/lib/account/store";
import { keyedHash } from "@/lib/account/token";
import { safeNextPath } from "@/lib/auth";

export const LOGIN_ID_INPUT_MAX = 64;
export const PASSWORD_INPUT_MAX = 128;

export interface LoginInput {
  config: Extract<AuthConfig, { kind: "accounts" }>;
  origin: OriginInput;
  form: { id: unknown; password: unknown; next: unknown };
  /** 送り主の IP（キー名にはハッシュだけを使う） */
  ip: string;
  secure: boolean;
  nowMs: number;
}

export interface LoginDeps {
  store: AccountStore;
  limiter: KeyedLimiter;
  scrypt?: ScryptParams;
}

export interface LoginResult {
  location: string;
  cookies: CookieSpec[];
}

const fail = (code: LoginErrorCode, next: string): LoginResult => {
  const params = new URLSearchParams({ error: code });
  if (next !== "/") params.set("next", next);
  return { location: `/login?${params.toString()}`, cookies: [] };
};

export async function handleLogin(input: LoginInput, deps: LoginDeps): Promise<LoginResult> {
  const next = safeNextPath(input.form.next);
  if (!isSameOriginPost(input.origin)) return fail("origin", "/");

  const rawId = typeof input.form.id === "string" ? input.form.id : "";
  const password = typeof input.form.password === "string" ? input.form.password : "";
  if (rawId.length === 0 || password.length === 0) return fail("1", next);
  if (rawId.length > LOGIN_ID_INPUT_MAX || password.length > PASSWORD_INPUT_MAX) return fail("1", next);
  const id = normalizeLoginId(rawId);

  const { secret } = input.config;
  const ipHash = keyedHash(secret, "fail-ip", input.ip || "unknown");
  if (!deps.limiter.take(ipHash, input.nowMs)) return fail("locked", next);

  const failIdKey = KEYS.failId(keyedHash(secret, "fail-id", id));
  const failIpKey = KEYS.failIp(ipHash);
  const nowSec = Math.floor(input.nowMs / 1000);

  try {
    const snapshot = await deps.store.loginSnapshot(id, failIdKey, failIpKey);
    // ★止めている間は計算もしない
    if (snapshot.idFails >= FAIL_MAX_ID || snapshot.ipFails >= FAIL_MAX_IP) return fail("locked", next);

    const record = snapshot.record;
    const typed = record?.mustChange ? canonicalTemp(password) : password;
    const matched = await verifyPassword(typed, record ? record.hash : await dummyHash(deps.scrypt));

    if (!matched || !record) {
      const admin = await tryBootstrap(input, deps, id, password);
      if (admin) return success(admin, input, next, nowSec);
      await deps.store.recordFailure([failIdKey, failIpKey]);
      return fail("1", next);
    }
    if (record.disabled) return fail("disabled", next);
    if (record.mustChange && (record.tempExpiresAt === null || record.tempExpiresAt <= input.nowMs)) {
      return fail("temp-expired", next);
    }
    await deps.store.clearFailures(failIdKey);
    return success(record, input, next, nowSec);
  } catch (e) {
    if (e instanceof StoreUnavailableError) return fail("unavailable", next);
    throw e;
  }
}

function success(record: AccountRecord, input: LoginInput, next: string, nowSec: number): LoginResult {
  const { cookies } = issueSession({ record, secret: input.config.secret, secure: input.secure, nowSec });
  // ★仮のパスワードの人は、まず自分のパスワードを決める画面へ（行きたかった画面はそのあと）
  if (record.mustChange) {
    const params = new URLSearchParams();
    if (next !== "/") params.set("next", next);
    const query = params.toString();
    return { location: `/account${query ? `?${query}` : ""}`, cookies };
  }
  return { location: next, cookies };
}

/** 最初の管理者のコードで入る（1回だけ）。入れたら、その ID を管理者にしてパスワードを決めさせる */
async function tryBootstrap(input: LoginInput, deps: LoginDeps, id: string, password: string): Promise<AccountRecord | null> {
  const boot = parseBootstrap(input.config.bootstrap);
  if (!boot || boot.loginId !== id || boot.expSec * 1000 <= input.nowMs) return null;
  if (!(await verifyPassword(canonicalTemp(password), boot.hash))) return null;
  // ★照合が合ってから、使った印を置く（ほかの ID の失敗では使い切られない）
  const usedKey = KEYS.boot(keyedHash(input.config.secret, "boot", input.config.bootstrap ?? ""));
  if (!(await deps.store.markBootstrapUsed(usedKey))) return null;
  const now = input.nowMs;
  return deps.store.upsert(id, (current) => ({
    v: 1,
    id,
    name: current?.name ?? "管理者",
    role: "admin",
    hash: boot.hash,
    mustChange: true,
    tempExpiresAt: now + MUST_CHANGE_MAX_SEC * 1000,
    disabled: false,
    sv: now,
    createdAt: current?.createdAt ?? now,
    passwordChangedAt: current?.passwordChangedAt ?? null,
  }));
}
