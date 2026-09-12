import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 楽楽精算のログイン状態（クッキー）を、ブラウザに預けられる形に封じる。
 *
 * ★ 中身は楽楽精算のクッキーそのもの。持っている人はその利用者として操作できるので、
 *   **署名ではなく暗号化**して、Folio のサーバー以外では読めないようにする。
 * ★ ブラウザ側ではメモリにだけ置く（保存しない）。有効期限も入れる。
 */
const ALGORITHM = "aes-256-gcm";
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export interface SessionPayload {
  /** playwright の storageState をそのまま入れた文字列 */
  state: string;
  /** ログイン後に着いた画面。次回はここを開いて状態を確かめる */
  home: string;
  /** 期限 (epoch ミリ秒) */
  exp: number;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

function key(): Buffer {
  const secret = process.env.RAKURAKU_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new SessionError("RAKURAKU_SESSION_SECRET が未設定か短すぎます (32文字以上)");
  }
  return createHash("sha256").update(secret).digest();
}

export function seal(
  input: { state: string; home: string },
  ttlMs = DEFAULT_TTL_MS,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const payload: SessionPayload = { ...input, exp: Date.now() + ttlMs };
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  // iv . 認証タグ . 本体
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function unseal(token: string): SessionPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SessionError("セッションの形が不正です");
  let json: string;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof SessionError) throw e;
    // 中身を見せない (改ざんの手がかりを与えない)
    throw new SessionError("セッションを読めませんでした。ログインし直してください");
  }
  const payload = JSON.parse(json) as SessionPayload;
  if (
    typeof payload.state !== "string" ||
    typeof payload.home !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new SessionError("セッションの中身が不正です");
  }
  if (payload.exp < Date.now()) {
    throw new SessionError("セッションの期限が切れています。ログインし直してください");
  }
  return payload;
}
