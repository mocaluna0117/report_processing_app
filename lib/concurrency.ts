/**
 * 上限付きの並列実行。
 * 待ち時間の大半が API 応答なので、ペアを並列に流すと処理時間が大きく縮む。
 * ただし巨大PDF (50MB級) が同時に載るとブラウザのメモリを圧迫するため、
 * 「同時実行数」と「同時に扱う合計バイト数」の両方で上限をかける。
 */
export interface RunTask<T> {
  /** このタスクが扱うバイト数 (メモリ見積り用) */
  bytes: number;
  run: () => Promise<T>;
}

export interface RunOptions {
  /** 同時実行数の上限 */
  concurrency: number;
  /** 同時に扱う合計バイト数の上限 (超える場合は空くまで待つ) */
  byteBudget: number;
}

/**
 * タスクを上限付きで並列実行し、完了順ではなく入力順に結果を返す。
 * 各タスクの完了時に onDone を呼ぶ (進捗表示用)。
 * どのタスクも reject しない前提 (呼び出し側で catch 済みの値を返すこと)。
 */
export async function runLimited<T>(
  tasks: RunTask<T>[],
  opts: RunOptions,
  onDone?: (result: T, index: number) => void,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  const concurrency = Math.max(1, opts.concurrency);
  let next = 0;
  let inFlightBytes = 0;
  const running = new Set<Promise<void>>();

  const start = (index: number) => {
    const task = tasks[index];
    inFlightBytes += task.bytes;
    const p = task.run().then((r) => {
      results[index] = r;
      inFlightBytes -= task.bytes;
      onDone?.(r, index);
      running.delete(p);
    });
    running.add(p);
  };

  while (next < tasks.length || running.size > 0) {
    // 空きがある限りタスクを起動する。バイト上限を超える場合は、
    // 何も走っていなければ(=単体で上限超え)例外的に起動して進行を止めない
    while (
      next < tasks.length &&
      running.size < concurrency &&
      (running.size === 0 || inFlightBytes + tasks[next].bytes <= opts.byteBudget)
    ) {
      start(next);
      next++;
    }
    if (running.size > 0) await Promise.race(running);
  }

  return results;
}
