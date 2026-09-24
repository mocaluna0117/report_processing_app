/**
 * ログインの印（folio_session）の署名。proxy.ts・API のルートの両方から使う。
 *
 * 形は `v2.<b64url(JSON{u, sv, mc, chk, exp})>.<b64url(HMAC-SHA256(secret, "folio-session.v2." + payload))>`。
 * - u: ログインID / sv: アカウントの版（パスワードを変える・止めると変わる）
 * - mc: 1 のあいだは「パスワードを決めるまでの仮の入場」 / chk: 最後に Redis で確かめた時刻（秒）
 * - exp: 期限（秒）
 *
 * ★proxy から読むので server-only は付けない（proxy は react-server の外で動く）。Node で動くので node:crypto は使える。
 * ★中身にパスワードや役割（管理者か）は入れない。役割は毎回 Redis で見る。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  u: string;
  sv: number;
  mc: 0 | 1;
  chk: number;
  exp: number;
}

const PREFIX = "v2";
const MAX_TOKEN = 1024;
/** 期限の長さの上限（chk からの長さ。これより長いものは作られていないはず） */
const MAX_LIFETIME_SEC = 366 * 24 * 60 * 60;
const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const mac = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(`folio-session.v2.${payload}`).digest();

export function signSession(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${PREFIX}.${payload}.${mac(payload, secret).toString("base64url")}`;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** 署名・形・時刻が正しければ中身を返す。★どんな値でも例外を出さない */
export function verifySession(token: string | undefined | null, secret: string, nowSec: number): SessionClaims | null {
  if (!token || token.length > MAX_TOKEN || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = mac(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.u !== "string" || !LOGIN_ID.test(c.u)) return null;
  if (!isInt(c.sv) || !isInt(c.chk) || !isInt(c.exp)) return null;
  if (c.mc !== 0 && c.mc !== 1) return null;
  if (c.exp <= nowSec) return null;
  if (c.chk > nowSec + 60) return null;
  if (c.exp - c.chk > MAX_LIFETIME_SEC) return null;
  return { u: c.u, sv: c.sv, mc: c.mc, chk: c.chk, exp: c.exp };
}

/** 打ち込まれた ID や IP を、そのままキー名に残さないための HMAC（先頭16文字） */
export function keyedHash(secret: string, label: string, value: string): string {
  return createHmac("sha256", secret).update(`${label}|${value}`).digest("base64url").slice(0, 16);
}
