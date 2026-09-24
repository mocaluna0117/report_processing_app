import "server-only";

/**
 * パスワードをしまう（scrypt。node:crypto だけで、新しい部品は入れない）。
 *
 * ★しまうのは元に戻せない形（ハッシュ）だけ。パスワードそのものは、どこにも残さない。
 * ★仮のパスワードは「xxxx-xxxx-xxxx」の形で出し、照合では大文字・小文字・ハイフン・空白を区別しない
 *   （電話や紙で伝えても打ち間違えにくくするため）。
 */
import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { normalizePassword } from "@/lib/account/policy";

export interface ScryptParams {
  log2N: number;
  r: number;
  p: number;
}

/** 本番の強さ（1回およそ 50〜100ms・メモリ 32MB） */
export const DEFAULT_SCRYPT: ScryptParams = { log2N: 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

const b64url = (buf: Buffer) => buf.toString("base64url");

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      normalizePassword(password),
      salt,
      KEY_LENGTH,
      { N: 2 ** params.log2N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** 形は `scrypt$1$<log2N>.<r>.<p>$<salt>$<hash>` */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return `scrypt$1$${params.log2N}.${params.r}.${params.p}$${b64url(salt)}$${b64url(key)}`;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt" || parts[1] !== "1") return null;
  const nums = parts[2].split(".").map(Number);
  if (nums.length !== 3 || !nums.every((n) => Number.isInteger(n) && n > 0)) return null;
  const [log2N, r, p] = nums;
  // ★壊れた値・大きすぎる値で計算を重くさせない
  if (log2N > 20 || r > 16 || p > 4) return null;
  const salt = Buffer.from(parts[3], "base64url");
  const key = Buffer.from(parts[4], "base64url");
  if (salt.length < 16 || key.length !== KEY_LENGTH) return null;
  return { params: { log2N, r, p }, salt, key };
}

/** 照合する。★壊れた値でも例外を出さず false */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const key = await derive(password, parsed.salt, parsed.params);
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/**
 * ID が無いときにも同じだけ計算するための、ダミーのハッシュ（時間の差で ID の有無を悟らせない）。
 * 起動ごとに作る（固定の値をコードに置かない）。
 */
let dummy: Promise<string> | null = null;
export function dummyHash(params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  dummy ??= hashPassword(randomBytes(18).toString("base64url"), params);
  return dummy;
}

/** 仮のパスワードに使う文字（見間違えやすい 0/o・1/l/i は外す） */
const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 仮のパスワード（12文字。xxxx-xxxx-xxxx）。★Math.random は使わない */
export function generateTempPassword(): string {
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  }
  return out;
}

/** 仮のパスワードの照合用の形（大文字・小文字・ハイフン・空白を区別しない） */
export function canonicalTemp(raw: string): string {
  return normalizePassword(raw).toLowerCase().replace(/[\s\-‐－ー]/g, "");
}
