/**
 * パスワード保護のセッション。純関数のみ (proxy.ts と /api/login から使う)。
 *
 * HTTP Basic認証はブラウザ標準のダイアログを出すため、
 * パスワードマネージャーが保存・自動入力できず、ブラウザを閉じると資格情報も消える。
 * そこで通常のログインフォーム + 署名付きの長期クッキーにする。
 *
 * 署名の鍵は APP_PASSWORD をそのまま使う (環境変数を増やさないため)。
 * パスワードを変えると、それまでのセッションはすべて無効になる。
 */

/** 署名付きのセッション (httpOnly。中身は有効期限と署名だけで、パスワードは入れない) */
export const SESSION_COOKIE = "folio_session";
/**
 * ログイン中かどうかだけを表す印 (httpOnly ではない)。
 * 画面に「ログアウト」を出すかの判断に使う。認証には使わない。
 */
export const SIGNED_IN_COOKIE = "folio_signed_in";

/** 既定のログイン保持期間 (日)。APP_SESSION_DAYS で変えられる */
const DEFAULT_SESSION_DAYS = 30;

export function sessionMaxAgeSeconds(rawDays = process.env.APP_SESSION_DAYS): number {
  const days = Number(rawDays);
  const valid = Number.isFinite(days) && days > 0 && days <= 365 ? days : DEFAULT_SESSION_DAYS;
  return Math.floor(valid * 24 * 60 * 60);
}

const encoder = new TextEncoder();

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

/** 長さが違っても早く返さない比較 (パスワード・署名の照合用) */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * セッションの値を作る。形式は `v1.<有効期限(秒)>.<署名>`。
 * 中身を見てもパスワードは分からず、署名が合わなければ弾ける。
 */
export async function createSessionToken(
  user: string,
  password: string,
  maxAgeSeconds: number,
  now: number = Date.now(),
): Promise<string> {
  const exp = Math.floor(now / 1000) + maxAgeSeconds;
  return `v1.${exp}.${await sign(`${user}:${exp}`, password)}`;
}

/** セッションの値が正しく、期限内かを見る */
export async function verifySessionToken(
  token: string | undefined,
  user: string,
  password: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 <= now) return false;
  return safeEqual(parts[2], await sign(`${user}:${exp}`, password));
}

/** ログインフォームから受け取った資格情報を照合する */
export function isValidCredentials(
  user: string,
  password: string,
  expectedUser: string,
  expectedPassword: string,
): boolean {
  // どちらか一方だけ先に返さないよう、両方を必ず比較する
  const userOk = safeEqual(user, expectedUser);
  const passwordOk = safeEqual(password, expectedPassword);
  return userOk && passwordOk;
}

/** Basic認証ヘッダー (スクリプトからの利用・vercel curl 用に残している) */
export function parseBasicAuth(header: string): { user: string; password: string } | null {
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (sep <= 0) return null;
    return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    // 不正なbase64は未認証として扱う
    return null;
  }
}
