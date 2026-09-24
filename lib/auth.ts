/**
 * パスワード保護のセッション。純関数のみ (proxy.ts と /api/login から使う)。
 * ★画面の部品（components/mode-nav.tsx）からも import されるので、秘密・node:crypto・server-only を入れない。
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

/** 戻り先に使ってよい長さの上限 */
const NEXT_PATH_MAX = 512;

/**
 * ログイン後の「戻り先」を、このアプリの中のパスだけに限る（外部サイトへ飛ばさない）。
 * 使えないものはすべて "/" にする。
 *
 * ★`//evil.com` だけでなく、`/\evil.com`・`/\t/evil.com`（ブラウザはバックスラッシュをスラッシュと、
 *   タブ・改行を無いものとして読む）や、`/.//evil.com`（読み直すと `//evil.com` になる）も弾く。
 *   tests/auth.test.ts に抜け道の一覧がある。
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > NEXT_PATH_MAX) return "/";
  // 制御文字・バックスラッシュ・%5C（エンコードしたバックスラッシュ）は、それだけで断る
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || /%5c/i.test(raw)) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  let url: URL;
  try {
    url = new URL(raw, "http://folio.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "http://folio.invalid") return "/";
  // 読み直したあとに「//」で始まるもの（/.//evil.com・/%2e//evil.com など）も断る
  if (url.pathname.startsWith("//")) return "/";
  // ログインの画面・API へは戻さない（ぐるぐる回る・POST の口を GET で開く）
  if (url.pathname === "/login" || url.pathname.startsWith("/api/")) return "/";
  // Next の内部の目印は捨てる
  url.searchParams.delete("_rsc");
  return `${url.pathname}${url.search}`;
}
