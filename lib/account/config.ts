/**
 * Folio のログインの設定を環境変数から読む。純関数（env を引数で受け取る）。
 *
 * - off:      手元で、アカウントを使わない（今までの開発・写真撮りと同じ。全部通す）
 * - accounts: 人ごとのアカウント（本番は Upstash Redis、手元の開発はファイル）
 * - broken:   Vercel の上なのに設定が足りない → ★全部を閉じる（503）。開いたままにしない
 *
 * ★足りないものは「名前」だけを返す（値は出さない）。
 */
export type AuthConfig =
  | { kind: "off" }
  | { kind: "broken"; missing: string[] }
  | {
      kind: "accounts";
      store: { kind: "redis"; url: string; token: string } | { kind: "file"; path: string };
      secret: string;
      /**
       * 旧合言葉のクッキー（v1）を受け付ける間だけ入る。
       * ★APP_PASSWORD と、受け付ける期限 FOLIO_LEGACY_UNTIL（秒）の両方があるときだけ。期限を過ぎたら自動で止まる
       */
      legacy: { password: string; user: string; untilSec: number } | null;
      /** 最初の管理者のコード（使い終わったら env から消す） */
      bootstrap: string | null;
    };

export type Env = Record<string, string | undefined>;

export const SECRET_MIN = 32;
export const DEV_ACCOUNTS_FILE = ".cache/folio-dev-accounts.json";

/** Vercel の上（本番・preview）か、本番の組み立てで動いているか */
export function isStrictEnv(env: Env): boolean {
  return (
    env.VERCEL === "1" || env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" || env.NODE_ENV === "production"
  );
}

export function readAuthConfig(env: Env): AuthConfig {
  const strict = isStrictEnv(env);
  const mode = env.FOLIO_ACCOUNTS?.trim();
  if (!strict && !mode) {
    // ★手元でも、前の合言葉で守るつもりで APP_PASSWORD だけ入れた場合は、開いたままにせず止める
    //   （前は APP_PASSWORD だけで守れた。今はアカウントの設定が要る）
    if (env.APP_PASSWORD) return { kind: "broken", missing: ["FOLIO_ACCOUNTS"] };
    return { kind: "off" };
  }
  // ★手元の開発用の置き場所は、本番では使わない
  const useFile = !strict && mode === "file";

  const missing: string[] = [];
  const secret = env.FOLIO_SESSION_SECRET ?? "";
  if (secret.length < SECRET_MIN) missing.push("FOLIO_SESSION_SECRET");

  let store: Extract<AuthConfig, { kind: "accounts" }>["store"] | null = null;
  if (useFile) {
    store = { kind: "file", path: DEV_ACCOUNTS_FILE };
  } else {
    const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "";
    const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url.startsWith("https://")) missing.push("KV_REST_API_URL");
    if (!token) missing.push("KV_REST_API_TOKEN");
    if (url.startsWith("https://") && token) store = { kind: "redis", url, token };
  }
  if (missing.length > 0 || !store) return { kind: "broken", missing };

  const legacyPassword = env.APP_PASSWORD ?? "";
  const legacyUntil = Number(env.FOLIO_LEGACY_UNTIL ?? "");
  return {
    kind: "accounts",
    store,
    secret,
    legacy:
      legacyPassword && Number.isSafeInteger(legacyUntil) && legacyUntil > 0
        ? { password: legacyPassword, user: env.APP_USER || "user", untilSec: legacyUntil }
        : null,
    bootstrap: env.FOLIO_BOOTSTRAP?.trim() || null,
  };
}
