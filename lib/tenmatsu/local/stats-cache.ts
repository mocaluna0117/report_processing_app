/**
 * PDF のページ数の控えを、このブラウザ（IndexedDB）に置く。
 * ★キーは「パス・大きさ・更新日時」なので、PDF が書き換わったら自然に数え直しになる。
 *   控えそのものに個人情報は入らない（ファイル名とページ数だけ）。
 */
import type { DocKindId } from "@/lib/tenmatsu/kinds";
import { loadPdfStats, savePdfStats } from "@/lib/tenmatsu/store";
import type { StatsCache } from "./list";

/** 1つの控えに残す数の上限（古いものから捨てる）。移植元の記録が 700件ほどなので十分に大きく */
const MAX_ENTRIES = 5_000;

export function idbStatsCache(kind: DocKindId, options: { flushDelayMs?: number } = {}): StatsCache {
  let loaded: Promise<Map<string, number | null>> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    loaded ??= loadPdfStats(kind)
      .then((raw) => new Map(Object.entries(raw)))
      .catch(() => new Map<string, number | null>());
    return loaded;
  };
  const flush = async () => {
    const map = await load();
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
    await savePdfStats(kind, Object.fromEntries(map)).catch(() => undefined); // 控えなので失敗しても困らない
  };
  return {
    get: async (key) => {
      const map = await load();
      return map.has(key) ? map.get(key) : undefined;
    },
    set: async (key, pages) => {
      const map = await load();
      map.set(key, pages);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), options.flushDelayMs ?? 500);
    },
  };
}
