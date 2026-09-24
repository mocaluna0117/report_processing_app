/**
 * ログインのクッキーの名前・表示用の印・戻り先の検査。純関数のみ。
 * ★画面の部品（components/account-menu.tsx など）からも import されるので、秘密・node:crypto・server-only を入れない。
 *   印の署名は lib/account/token.ts、読み書きは lib/account/session.ts。
 *
 * ★前の共通の合言葉（APP_PASSWORD）の印（v1）は、2026-09-25 に受け付けるのをやめた。
 */

/** 署名付きのセッション (httpOnly。中身は ID・版・期限と署名だけで、パスワードは入れない) */
export const SESSION_COOKIE = "folio_session";
/**
 * 誰がログインしているかを表す印 (httpOnly ではない)。
 * 右上に名前を出すのに使う。認証には使わない。
 */
export const SIGNED_IN_COOKIE = "folio_signed_in";

/**
 * 表示用の印の中身（ヘッダーに名前を出す・管理の入口を出すため）。★認証には使わない（誰でも書き換えられる）。
 * ★前の合言葉のときの値 "1" は、もう読まない（null）。「前の合言葉」とは出さない。
 */
export interface SignedInMarker {
  id: string;
  name: string;
  admin: boolean;
  mustChange: boolean;
}

const utf8ToB64url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlToUtf8 = (value: string): string => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export function encodeSignedInMarker(marker: { id: string; name: string; admin: boolean; mustChange: boolean }): string {
  return utf8ToB64url(JSON.stringify({ u: marker.id, n: marker.name, a: marker.admin ? 1 : 0, m: marker.mustChange ? 1 : 0 }));
}

/** 読めなければ null（壊れた値・空）。★どんな値でも例外を出さない */
export function readSignedInMarker(raw: string | null | undefined): SignedInMarker | null {
  if (!raw || raw.length > 512) return null;
  try {
    const v = JSON.parse(b64urlToUtf8(raw)) as Record<string, unknown>;
    if (typeof v.u !== "string" || typeof v.n !== "string") return null;
    return { id: v.u, name: v.n.slice(0, 40), admin: v.a === 1, mustChange: v.m === 1 };
  } catch {
    return null;
  }
}

/** 既定のログイン保持期間 (日)。APP_SESSION_DAYS で変えられる */
const DEFAULT_SESSION_DAYS = 30;

export function sessionMaxAgeSeconds(rawDays = process.env.APP_SESSION_DAYS): number {
  const days = Number(rawDays);
  const valid = Number.isFinite(days) && days > 0 && days <= 365 ? days : DEFAULT_SESSION_DAYS;
  return Math.floor(valid * 24 * 60 * 60);
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
