/**
 * 設定と置き場所を、実行中の環境から用意する（proxy と API のルート）。
 * ★proxy からも読むので server-only は付けない。
 */
import { type AuthConfig, readAuthConfig } from "@/lib/account/config";
import { type Kv, createFileKv, createRedisKv } from "@/lib/account/kv";
import { type AccountStore, createAccountStore } from "@/lib/account/store";

export function currentAuthConfig(): AuthConfig {
  return readAuthConfig(process.env);
}

let cached: { key: string; kv: Kv; store: AccountStore } | null = null;

/** 置き場所のいちばん下（アカウントと同じ所。楽楽精算の自動ログインの状態もここに置く） */
export function kvFor(config: Extract<AuthConfig, { kind: "accounts" }>): Kv {
  const key = config.store.kind === "redis" ? `redis|${config.store.url}` : `file|${config.store.path}`;
  if (cached?.key !== key) {
    const kv = config.store.kind === "redis" ? createRedisKv(config.store) : createFileKv(config.store.path);
    cached = { key, kv, store: createAccountStore(kv) };
  }
  return cached.kv;
}

export function accountStoreFor(config: Extract<AuthConfig, { kind: "accounts" }>): AccountStore {
  kvFor(config);
  return (cached as NonNullable<typeof cached>).store;
}

/** Cookie ヘッダーから1つ読む */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}
