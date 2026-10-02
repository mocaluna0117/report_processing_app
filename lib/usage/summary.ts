/**
 * Redis のハッシュとアカウントの一覧から、利用状況の画面に送る形を作る。純関数。
 *
 * ★今あるアカウントの分だけを出す（消した人のキーが期限まで残っていても出さない）。
 * ★決まった名前・直近30日の日付・正の整数だけを拾う（壊れた項目で画面を止めない）。
 */
import type { AccountRole, AccountSummary } from "@/lib/account/record";
import { type Metric, USAGE_DAYS, datePrefixOf, isMetric, jstDayOf, recentDays } from "@/lib/usage/metrics";

export type DayCounts = Partial<Record<Metric, number>>;

export interface PersonUsage {
  id: string;
  name: string;
  role: AccountRole;
  disabled: boolean;
  loginAt: number | null;
  /** 最後に使った時刻（数える操作を最後にしたとき） */
  lastUsedAt: number | null;
  /** 日付（YYYYMMDD）→ その日の回数。回数の無い日は入れない */
  byDay: Record<string, DayCounts>;
}

export interface UsageReport {
  /** 今日（日本時間） */
  today: string;
  /** 直近30日（新しい順） */
  days: string[];
  people: PersonUsage[];
}

const LAST_FIELD = "last";

export function buildUsageReport(
  accounts: readonly AccountSummary[],
  hashes: readonly (Record<string, string> | null)[],
  nowMs: number,
): UsageReport {
  const days = recentDays(nowMs, USAGE_DAYS);
  const inWindow = new Set(days);
  const people = accounts.map((account, i): PersonUsage => {
    const hash = hashes[i] ?? {};
    const byDay: Record<string, DayCounts> = {};
    let lastUsedAt: number | null = null;
    for (const [field, raw] of Object.entries(hash)) {
      if (field === LAST_FIELD) {
        const at = Number(raw);
        if (Number.isSafeInteger(at) && at > 0) lastUsedAt = at;
        continue;
      }
      const day = datePrefixOf(field);
      if (day === null || !inWindow.has(day)) continue;
      const metric = field.slice(day.length + 1);
      const n = Number(raw);
      if (!isMetric(metric) || !Number.isSafeInteger(n) || n <= 0) continue;
      (byDay[day] ??= {})[metric] = n;
    }
    return {
      id: account.id,
      name: account.name,
      role: account.role,
      disabled: account.disabled,
      loginAt: account.loginAt,
      lastUsedAt,
      byDay,
    };
  });
  return { today: jstDayOf(nowMs), days, people };
}
