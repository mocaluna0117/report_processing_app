import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * 楽楽精算のIDとパスワードの「控え」を封じる・開く（2026-09-25 の利用者の決定）。
 *
 * ★控えは**ブラウザ（IndexedDB）に置く**。社外のクラウド（Upstash）には置かない。
 *   鍵は Folio のサーバーにだけあるので、PC の中身だけでは読めない。サーバーの鍵だけでも読めない（控えが無い）。
 * ★控えは Folio のアカウント（ID と作った時刻）に結び付ける（AAD）。ほかのアカウントでは開けず、
 *   同じ ID で作り直したアカウントでも開けない。
 * ★開くのは楽楽精算へログインするときだけ。パスワードはブラウザへ返さない・記録しない。
 * ★鍵は RAKURAKU_SESSION_SECRET から HKDF で作る（新しい環境変数を足さない）。
 *   その値を変えると、全員の登録が読めなくなる（入れ直し）。
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 形の目印（中身の作りを変えたら上げる） */
const PREFIX = "c1";
const HKDF_SALT = "folio-rakuraku-credential";
const HKDF_INFO = "folio/rakuraku-credential/v1";

/** 受け取る長さの上限 */
export const RAKURAKU_ID_MAX = 64;
export const RAKURAKU_PASSWORD_MAX = 256;
export const CREDENTIAL_SEALED_MAX = 2048;

/** 手元でアカウントを使わないとき（off）の持ち主 */
export const LOCAL_SUBJECT = "local";

export interface CredentialSecret {
  /** 楽楽精算のログインID */
  u: string;
  /** 楽楽精算のパスワード */
  p: string;
  /** 登録の版（「確かめて保存」に成功するたびに変わる。サーバーの状態と見比べる） */
  ver: string;
  savedAt: number;
}

/** 控えを結び付ける相手（Folio のアカウント） */
export interface CredentialBinding {
  folioId: string;
  createdAt: number;
}

export type CredentialErrorCode = "CREDENTIAL_KEY" | "CREDENTIAL_UNREADABLE";

export class CredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(
      code === "CREDENTIAL_KEY"
        ? "楽楽精算の登録に使う鍵が設定されていません（RAKURAKU_SESSION_SECRET）"
        : "このPCの楽楽精算の登録を読めませんでした。アカウントの画面で入れ直してください",
    );
    this.name = "CredentialError";
  }
}

export function credentialKey(secret: string | undefined = process.env.RAKURAKU_SESSION_SECRET): Buffer {
  if (!secret || secret.length < 32) throw new CredentialError("CREDENTIAL_KEY");
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32));
}

export function credentialAad(binding: CredentialBinding): Buffer {
  return Buffer.from(`folio:rkc:v1|${binding.folioId}|${binding.createdAt}`, "utf8");
}

export function newCredentialVer(): string {
  return randomBytes(12).toString("base64url");
}

/** 画面に出す伏せ字（末尾2文字だけ見せる） */
export function credentialIdHint(userId: string): string {
  const tail = [...userId.trim()].slice(-2).join("");
  return `••••${tail}`;
}

export function sealCredential(secret: CredentialSecret, binding: CredentialBinding, key: Buffer = credentialKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(credentialAad(binding));
  const body = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return [PREFIX, ...[iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url"))].join(".");
}

/** ★開けないときは中身を見せずに CredentialError（改ざんの手がかりを与えない） */
export function openCredential(sealed: unknown, binding: CredentialBinding, key: Buffer = credentialKey()): CredentialSecret {
  if (typeof sealed !== "string" || sealed.length === 0 || sealed.length > CREDENTIAL_SEALED_MAX) {
    throw new CredentialError("CREDENTIAL_UNREADABLE");
  }
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new CredentialError("CREDENTIAL_UNREADABLE");
  let value: unknown;
  try {
    const [iv, tag, body] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CredentialError("CREDENTIAL_UNREADABLE");
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(credentialAad(binding));
    decipher.setAuthTag(tag);
    value = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    throw new CredentialError("CREDENTIAL_UNREADABLE");
  }
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.u !== "string" ||
    typeof v.p !== "string" ||
    typeof v.ver !== "string" ||
    typeof v.savedAt !== "number" ||
    v.u.length === 0 ||
    v.u.length > RAKURAKU_ID_MAX ||
    v.p.length === 0 ||
    v.p.length > RAKURAKU_PASSWORD_MAX
  ) {
    throw new CredentialError("CREDENTIAL_UNREADABLE");
  }
  return { u: v.u, p: v.p, ver: v.ver, savedAt: v.savedAt };
}
