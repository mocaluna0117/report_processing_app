import "server-only";
import { type TenantConfig, readTenantConfig } from "./config";

/**
 * ルートを動かしてよいかの門番。
 *
 * ★ 楽楽精算を操作する口を、誰でも叩ける状態で公開しない。
 *   ログインを試みる口が野ざらしだと、**アカウントロックを起こす嫌がらせ**に使える。
 */
export type GuardCode = "DISABLED" | "PREVIEW_BLOCKED" | "NO_PASSWORD" | "FORBIDDEN_ORIGIN";

export class GuardError extends Error {
  constructor(
    readonly code: GuardCode,
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}

export function assertEnabled(): TenantConfig {
  const tenant = readTenantConfig();
  if (!tenant) {
    throw new GuardError("DISABLED", "楽楽精算の設定がされていません (RAKURAKU_LOGIN_URL)");
  }
  // 本番でパスワード保護が無いなら、この口も開けない
  if (process.env.VERCEL_ENV === "production" && !process.env.APP_PASSWORD) {
    throw new GuardError("NO_PASSWORD", "APP_PASSWORD が無いため無効です");
  }
  // プレビューは既定で止める (URL が毎回変わるので、意図せず本番の楽楽精算を触らせない)
  if (process.env.VERCEL_ENV === "preview" && process.env.RAKURAKU_ALLOW_PREVIEW !== "1") {
    throw new GuardError("PREVIEW_BLOCKED", "プレビュー環境では無効です");
  }
  return tenant;
}

/**
 * 別サイトからの POST を弾く。
 * 認証がクッキーなので、これが無いと他所のページから叩かれる (CSRF)。
 */
export function assertSameOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new GuardError("FORBIDDEN_ORIGIN", "別のサイトからは呼べません");
  }
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).origin !== new URL(request.url).origin) {
    throw new GuardError("FORBIDDEN_ORIGIN", "別のサイトからは呼べません");
  }
}
