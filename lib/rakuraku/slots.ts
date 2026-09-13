/**
 * 同じ実行環境の中で、楽楽精算を操作するブラウザを同時にいくつまで動かすか（順番待ち）。
 *
 * ★Vercel は同じ実行環境へ別の人の呼び出しを同時に流すことがある。Chromium は1つで200MB強使うので、
 *   重なりすぎるとメモリが足りなくなり、取得の途中で落ちる。上限を超えた分は少し待たせ、
 *   待っても空かなければ BROWSER_BUSY（やり直してよい）で返す。
 * ★Playwright にも server-only にも依存しない（順番待ちの規則だけをテストするため）。
 */
export class SlotTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotTimeoutError";
  }
}

export interface Slots {
  /** 空くまで待って1つ使う。戻り値の関数で返す（2回呼んでも1回分しか返さない） */
  acquire(waitMs: number): Promise<() => void>;
  readonly inUse: number;
  readonly waiting: number;
}

export function createSlots(limit: number): Slots {
  let inUse = 0;
  const queue: { grant: () => void }[] = [];

  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next.grant(); // 使っている数はそのまま、次の人へ渡す
      else inUse -= 1;
    };
  };

  return {
    acquire: (waitMs) => {
      if (inUse < limit) {
        inUse += 1;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        const entry = {
          grant: () => {
            clearTimeout(timer);
            resolve(releaser());
          },
        };
        const timer = setTimeout(() => {
          const at = queue.indexOf(entry);
          if (at >= 0) queue.splice(at, 1);
          reject(new SlotTimeoutError(`${Math.round(waitMs / 1000)}秒待っても空きませんでした`));
        }, waitMs);
        queue.push(entry);
      });
    },
    get inUse() {
      return inUse;
    },
    get waiting() {
      return queue.length;
    },
  };
}
