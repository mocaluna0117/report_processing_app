/**
 * Redis の手前で止める、メモリの回数制限（キーごと。1つのサーバーのインスタンスの中だけ）。
 * ★ログインの口を連打されても、Redis の無料枠（月50万回）を使い切らせないため。
 *   lib/contact/rate-limit.ts はキーの無い1本の数なので、ここでは使わない（1人の連打で全員が止まる）。
 */
export interface KeyedLimiter {
  /** 1回分を使う。上限を超えていたら使わずに false */
  take(key: string, now?: number): boolean;
}

export function createKeyedLimiter({ windowMs, max, maxKeys = 1_000 }: { windowMs: number; max: number; maxKeys?: number }): KeyedLimiter {
  const hits = new Map<string, number[]>();
  return {
    take: (key, now = Date.now()) => {
      const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // 古いキーを片付ける（覚えすぎない）
      if (hits.size > maxKeys) {
        for (const [k, list] of hits) {
          if (list.every((at) => now - at >= windowMs)) hits.delete(k);
          if (hits.size <= maxKeys) break;
        }
      }
      return true;
    },
  };
}
