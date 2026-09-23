/**
 * 送る回数の上限（1つのサーバーのインスタンスの中だけで数える。ほぼ守れる程度）。
 * ★本当の上限は Resend の 1日100通。ここは押し間違いの連打や、いたずらを止めるためのもの。
 */
export interface RateLimiter {
  /** 1回分を使う。上限を超えていたら使わずに false */
  take: (now?: number) => boolean;
  /** 次に送れるまでの秒数（今すぐ送れるなら 0） */
  waitSeconds: (now?: number) => number;
}

export function createRateLimiter({ windowMs, max }: { windowMs: number; max: number }): RateLimiter {
  let sent: number[] = [];
  const prune = (now: number) => {
    sent = sent.filter((at) => now - at < windowMs);
  };
  return {
    take: (now = Date.now()) => {
      prune(now);
      if (sent.length >= max) return false;
      sent.push(now);
      return true;
    },
    waitSeconds: (now = Date.now()) => {
      prune(now);
      if (sent.length < max) return 0;
      return Math.ceil((windowMs - (now - sent[0])) / 1000);
    },
  };
}
