/**
 * ログインの印（クッキー）を読む・出す・消す。proxy と API のルートの両方から使う。
 * ★proxy からも読むので server-only は付けない。
 */
import type { AuthConfig } from "@/lib/account/config";
import type { AccountRecord } from "@/lib/account/record";
import { type SessionClaims, signSession, verifySession } from "@/lib/account/token";
import {
  SESSION_COOKIE,
  SIGNED_IN_COOKIE,
  encodeSignedInMarker,
  sessionMaxAgeSeconds,
} from "@/lib/auth";

/**
 * 前に確かめてから、この秒数たったら Redis で確かめ直す（止めた・パスワードを変えた・ほかの端末でログインしたのが届くまで）。
 * ★画面を開いた・読み込み直したときは、これを待たずに毎回確かめる（lib/account/gate.ts）
 */
export const RECHECK_SEC = 5 * 60;
/** Redis が落ちているとき、前に確かめてからこの秒数までは通す */
export const OUTAGE_GRACE_SEC = 12 * 60 * 60;
/** 仮のパスワードで入ったときの印の長さ（パスワードを決めるまで） */
export const MUST_CHANGE_MAX_SEC = 12 * 60 * 60;

export type SessionState = { kind: "none"; hadToken: boolean } | { kind: "account"; claims: SessionClaims };

type AccountsConfig = Extract<AuthConfig, { kind: "accounts" }>;

/**
 * ★前の共通の合言葉の印（v1.…）は、2026-09-25 に受け付けるのをやめた。持っている端末は「切れた」扱いでログイン画面へ。
 */
export function readSession(token: string | undefined, config: AccountsConfig, nowSec: number): SessionState {
  if (!token) return { kind: "none", hadToken: false };
  const claims = token.startsWith("v2.") ? verifySession(token, config.secret, nowSec) : null;
  return claims ? { kind: "account", claims } : { kind: "none", hadToken: true };
}

export interface CookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

/** ログインの印を作る（本物の印と、ヘッダー用の表示の印） */
export function issueSession(input: {
  record: AccountRecord;
  secret: string;
  secure: boolean;
  nowSec: number;
  /** 今の印の期限を引き継ぐとき（確かめ直しで出し直すとき） */
  keepExp?: number;
}): { claims: SessionClaims; cookies: CookieSpec[] } {
  const { record, nowSec } = input;
  const mustChange = record.mustChange;
  let exp: number;
  if (input.keepExp !== undefined) {
    exp = input.keepExp;
  } else if (mustChange) {
    const tempLeft = record.tempExpiresAt ? Math.floor(record.tempExpiresAt / 1000) - nowSec : MUST_CHANGE_MAX_SEC;
    exp = nowSec + Math.max(60, Math.min(MUST_CHANGE_MAX_SEC, tempLeft));
  } else {
    exp = nowSec + sessionMaxAgeSeconds();
  }
  const claims: SessionClaims = { u: record.id, sv: record.sv, mc: mustChange ? 1 : 0, chk: nowSec, exp };
  const maxAge = Math.max(0, exp - nowSec);
  const base = { sameSite: "lax" as const, secure: input.secure, path: "/" as const, maxAge };
  return {
    claims,
    cookies: [
      { ...base, name: SESSION_COOKIE, value: signSession(claims, input.secret), httpOnly: true },
      {
        ...base,
        name: SIGNED_IN_COOKIE,
        value: encodeSignedInMarker({
          id: record.id,
          name: record.name,
          admin: record.role === "admin",
          mustChange,
        }),
        httpOnly: false,
      },
    ],
  };
}

/** 消すためのクッキー */
export function clearedCookies(secure: boolean): CookieSpec[] {
  return [SESSION_COOKIE, SIGNED_IN_COOKIE].map((name) => ({
    name,
    value: "",
    httpOnly: name === SESSION_COOKIE,
    sameSite: "lax" as const,
    secure,
    path: "/" as const,
    maxAge: 0,
  }));
}
