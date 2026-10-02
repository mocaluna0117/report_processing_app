import "server-only";

/**
 * 利用状況を読む（/account/usage の画面がサーバーで読む。管理者かどうかは画面の側で Redis を見て確かめてから呼ぶ）。
 */
import type { Kv } from "@/lib/account/kv";
import { summarizeAccount } from "@/lib/account/record";
import { type AccountStore, KEYS } from "@/lib/account/store";
import { type UsageReport, buildUsageReport } from "@/lib/usage/summary";

export async function loadUsageReport(deps: { store: AccountStore; kv: Kv }, nowMs: number): Promise<UsageReport> {
  const accounts = (await deps.store.list()).map(summarizeAccount);
  const hashes = await deps.kv.hgetallMany(accounts.map((a) => KEYS.usage(a.id)));
  return buildUsageReport(accounts, hashes, nowMs);
}
