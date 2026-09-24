import "server-only";

/**
 * /account の画面が、いまどの状態かを決める（サーバーで読む）。
 * ★印の中身だけを信じず、Redis で本人の今の状態を確かめる（止めた・版が違うなら、入り直してもらう）。
 */
import type { AuthConfig } from "@/lib/account/config";
import { StoreUnavailableError } from "@/lib/account/kv";
import type { AccountRecord } from "@/lib/account/record";
import { readSession } from "@/lib/account/session";
import type { AccountStore } from "@/lib/account/store";

export type AccountPageState =
  /** 手元の開発で、アカウントを使っていない */
  | { kind: "off" }
  /** 旧合言葉で入っている（切り替えの前後） */
  | { kind: "legacy"; switched: boolean }
  /** 入り直しが要る */
  | { kind: "expired" }
  | { kind: "unavailable" }
  | { kind: "account"; record: AccountRecord; forced: boolean };

export async function accountPageState(
  config: AuthConfig,
  token: string | undefined,
  store: (config: Extract<AuthConfig, { kind: "accounts" }>) => AccountStore,
  nowSec: number,
): Promise<AccountPageState> {
  if (config.kind === "off") return { kind: "off" };
  if (config.kind === "broken") return { kind: "unavailable" };
  const session = await readSession(token, config, nowSec);
  if (session.kind === "legacy") return { kind: "legacy", switched: true };
  if (session.kind === "none") return { kind: "expired" };
  try {
    const record = await store(config).get(session.claims.u);
    if (!record || record.disabled || record.sv !== session.claims.sv) return { kind: "expired" };
    return { kind: "account", record, forced: session.claims.mc === 1 };
  } catch (e) {
    if (e instanceof StoreUnavailableError) return { kind: "unavailable" };
    throw e;
  }
}
