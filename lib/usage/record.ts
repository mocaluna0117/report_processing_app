import "server-only";

/**
 * 利用状況を書く（Redis のハッシュ `folio:use:<ログインID>`）。
 *
 * ★本来の処理を止めない・遅らせない。返事を返したあと（next/server の after）に書き、失敗は黙って捨てる。
 * ★残すのは決まった名前の回数と、最後に使った時刻だけ（lib/usage/metrics.ts）。
 * ★アカウントを使わない手元（id が null）では何もしない。
 */
import { after } from "next/server";
import type { Kv } from "@/lib/account/kv";
import { currentAuthConfig, kvFor } from "@/lib/account/runtime";
import { KEYS } from "@/lib/account/store";
import { type Metric, USAGE_DAYS, isMetric, jstDayOf, recentDays } from "@/lib/usage/metrics";

/** 古い日の項目は、日の印が初めて置かれたときに消す（見せる30日＋1日の余裕） */
const KEEP_DAYS = USAGE_DAYS + 1;
/** 使わなくなった人のキーは、最後に書いてから60日で消える */
export const USAGE_TTL_SEC = 60 * 24 * 60 * 60;

/** 最後に使った時刻の項目 */
export const LAST_FIELD = "last";

export async function writeUsage(kv: Kv, id: string, metrics: readonly Metric[], nowMs: number): Promise<void> {
  const day = jstDayOf(nowMs);
  const add: Record<string, number> = {};
  for (const metric of metrics) {
    // ★型をすり抜けた名前は残さない
    if (!isMetric(metric)) continue;
    add[`${day}:${metric}`] = (add[`${day}:${metric}`] ?? 0) + 1;
  }
  if (Object.keys(add).length === 0) return;
  await kv.hincr(KEYS.usage(id), {
    add,
    max: { [LAST_FIELD]: nowMs },
    dayMark: `${day}:_`,
    pruneBefore: recentDays(nowMs, KEEP_DAYS).at(-1) as string,
    ttlSec: USAGE_TTL_SEC,
  });
}

/** 今の設定で書く。★例外は外へ出さない */
export async function recordUsage(id: string | null, metrics: readonly Metric[], nowMs = Date.now()): Promise<void> {
  if (!id || metrics.length === 0) return;
  try {
    const config = currentAuthConfig();
    if (config.kind !== "accounts") return;
    await writeUsage(kvFor(config), id, metrics, nowMs);
  } catch {
    // 利用状況が書けなくても、使っている人には関係が無い
  }
}

/**
 * 返事のあとで書く。metrics は、処理が終わってから決まる（楽楽精算の流す返事）ときは Promise で渡す。
 * ★after は要求の中でしか呼べない（テストなど）。そのときはその場で書きに行く
 */
export function scheduleUsage(id: string | null, metrics: readonly Metric[] | Promise<readonly Metric[]>): void {
  if (!id) return;
  const run = async () => recordUsage(id, await Promise.resolve(metrics).catch(() => []));
  try {
    after(run);
  } catch {
    void run();
  }
}
