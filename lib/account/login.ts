import "server-only";

/**
 * ログイン（POST /api/login）。外とのやり取りは deps で受け取る。
 *
 * 順:
 * 1. 同じサイトから送られたか（login CSRF を防ぐ）
 * 2. 長さの上限
 * 3. メモリの回数制限（IP ごと。Redis の手前で止め、無料枠を使い切らせない）
 * 4. ★照合する前に回数を数える（ID 5回・IP 30回で15分止める）。同時に何回送られても上限を超えて照合しない。
 *    正しく入れたら ID の分は数え直し、場所（IP）の分は1つ戻す（同じ事務所の人の失敗が積もって、全員が止まらないように）
 * 5. scrypt で照合（ID が無くてもダミーで計算する。時間の差で ID の有無を悟らせない）
 * 6. 最初の管理者のコードも確かめる（★ID に関わらず同じだけ計算する。時間の差で管理者の ID を悟らせない）
 *
 * ★違ったときは「ログインIDかパスワードが違います」だけ（ID の有無・停止中を言い分けない）。
 *   停止中・仮のパスワードの期限切れは、パスワードが合っていたときだけ言う。
 * ★止まっている間も、最初の管理者のコード（その ID）だけは確かめる（止められても回復できるように）。
 */
import type { AuthConfig } from "@/lib/account/config";
import { type Bootstrap, parseBootstrap } from "@/lib/account/bootstrap";
import { StoreUnavailableError } from "@/lib/account/kv";
import type { LoginErrorCode } from "@/lib/account/messages";
import { type OriginInput, isSameOriginPost } from "@/lib/account/origin";
import { createHash } from "node:crypto";
import { canonicalTemp, dummyHash, type ScryptParams, verifyPassword } from "@/lib/account/password";
import { PASSWORD_MAX, normalizeLoginId, normalizePassword } from "@/lib/account/policy";
import type { KeyedLimiter } from "@/lib/account/rate-limit";
import type { AccountRecord } from "@/lib/account/record";
import { type CookieSpec, MUST_CHANGE_MAX_SEC, issueSession } from "@/lib/account/session";
import { type AccountStore, FAIL_MAX_ID, FAIL_MAX_IP, KEYS } from "@/lib/account/store";
import { keyedHash } from "@/lib/account/token";
import { safeNextPath } from "@/lib/auth";

export const LOGIN_ID_INPUT_MAX = 64;
/** 受け取る長さの上限（そろえる前。scrypt に大きな値を渡させない） */
export const PASSWORD_RAW_MAX = 1024;

/** パスワードの長さを、決まり（lib/account/policy.ts）と同じ数え方で見る（そろえたあとの文字数） */
export function passwordTooLong(raw: string): boolean {
  return raw.length > PASSWORD_RAW_MAX || [...normalizePassword(raw)].length > PASSWORD_MAX;
}

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
  if (rawId.length > LOGIN_ID_INPUT_MAX || passwordTooLong(password)) return fail("1", next);
  const id = normalizeLoginId(rawId);

  const { secret } = input.config;
  const ipHash = keyedHash(secret, "fail-ip", input.ip || "unknown");
  if (!deps.limiter.take(ipHash, input.nowMs)) return fail("locked", next);

  const failIdKey = KEYS.failId(keyedHash(secret, "fail-id", id));
  const failIpKey = KEYS.failIp(ipHash);
  const nowSec = Math.floor(input.nowMs / 1000);

  const boot = parseBootstrap(input.config.bootstrap);
  const bootLive = boot !== null && boot.expSec * 1000 > input.nowMs ? boot : null;

  try {
    const [idCount, ipCount] = await deps.store.reserveAttempt([failIdKey, failIpKey]);
    if (idCount > FAIL_MAX_ID || ipCount > FAIL_MAX_IP) {
      // ★止まっている間も、最初の管理者のコードだけは確かめる（回復の道を残す）
      if (bootLive && bootLive.loginId === id && (await verifyPassword(canonicalTemp(password), bootLive.hash))) {
        const admin = await consumeBootstrap(input, deps, bootLive, id);
        if (admin) {
          await deps.store.clearFailures(failIdKey);
          await deps.store.releaseAttempt(failIpKey);
          return success(admin, input, next, nowSec);
        }
      }
      return fail("locked", next);
    }

    const record = await deps.store.get(id);
    const typed = record?.mustChange ? canonicalTemp(password) : password;
    const matched = await verifyPassword(typed, record ? record.hash : await dummyHash(deps.scrypt));
    // ★最初の管理者のコードの確かめは、どの ID でも同じだけ計算する
    const bootMatched = bootLive ? (await verifyPassword(canonicalTemp(password), bootLive.hash)) && bootLive.loginId === id : false;

    if (!matched || !record) {
      if (bootLive && bootMatched) {
        const admin = await consumeBootstrap(input, deps, bootLive, id);
        if (admin) {
          await deps.store.clearFailures(failIdKey);
          await deps.store.releaseAttempt(failIpKey);
          return success(admin, input, next, nowSec);
        }
      }
      return fail("1", next);
    }
    if (record.disabled) return fail("disabled", next);
    if (record.mustChange && (record.tempExpiresAt === null || record.tempExpiresAt <= input.nowMs)) {
      return fail("temp-expired", next);
    }
    await deps.store.clearFailures(failIdKey);
    await deps.store.releaseAttempt(failIpKey);
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

/** 使った印のキー。★秘密を混ぜない（秘密を変えても、使った印が消えたことにならないように） */
export function bootstrapUsedKey(value: string): string {
  return KEYS.boot(createHash("sha256").update(value).digest("base64url").slice(0, 22));
}

/**
 * 最初の管理者のコードを使う（照合が合ったあとで呼ぶ）。1回だけ。その ID を管理者にしてパスワードを決めさせる。
 * ★使った印はコードの期限より長く残す（期限の前に印だけ消えて、同じコードでまた入れることが無いように）。
 * ★管理者を書けなかったら印を外す（コードを無駄にしない）。
 */
async function consumeBootstrap(input: LoginInput, deps: LoginDeps, boot: Bootstrap, id: string): Promise<AccountRecord | null> {
  const usedKey = bootstrapUsedKey(input.config.bootstrap ?? "");
  const remainingSec = boot.expSec - Math.floor(input.nowMs / 1000);
  if (!(await deps.store.markBootstrapUsed(usedKey, remainingSec + 24 * 60 * 60))) return null;
  const now = input.nowMs;
  try {
    const admin = await deps.store.upsert(id, (current) => ({
      v: 1,
      id,
      name: boot.name ?? current?.name ?? "管理者",
      role: "admin",
      hash: boot.hash,
      mustChange: true,
      tempExpiresAt: now + MUST_CHANGE_MAX_SEC * 1000,
      disabled: false,
      sv: now,
      createdAt: current?.createdAt ?? now,
      passwordChangedAt: current?.passwordChangedAt ?? null,
    }));
    if (!admin) await deps.store.unmarkBootstrap(usedKey).catch(() => undefined);
    return admin;
  } catch (e) {
    await deps.store.unmarkBootstrap(usedKey).catch(() => undefined);
    throw e;
  }
}
