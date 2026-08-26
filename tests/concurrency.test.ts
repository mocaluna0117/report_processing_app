import { describe, expect, it } from "vitest";
import { runLimited } from "@/lib/concurrency";

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("runLimited", () => {
  it("入力順に結果を返す", async () => {
    const tasks = [30, 10, 20].map((delay, i) => ({
      bytes: 1,
      run: () => new Promise<number>((r) => setTimeout(() => r(i), delay)),
    }));
    expect(await runLimited(tasks, { concurrency: 3, byteBudget: 100 })).toEqual([0, 1, 2]);
  });

  it("同時実行数の上限を超えない", async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 7 }, () => ({
      bytes: 1,
      run: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return 1;
      },
    }));
    await runLimited(tasks, { concurrency: 3, byteBudget: 1000 });
    expect(peak).toBe(3);
  });

  it("バイト上限を超える組み合わせは同時に走らせない", async () => {
    const gates = [defer(), defer()];
    let started = 0;
    const tasks = gates.map((g) => ({
      bytes: 60,
      run: async () => {
        started++;
        await g.promise;
        return started;
      },
    }));
    const all = runLimited(tasks, { concurrency: 4, byteBudget: 100 });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1); // 60+60 > 100 なので2件目は待たされる
    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(2);
    gates[1].resolve();
    await all;
  });

  it("単体でバイト上限を超えるタスクも実行される (進行が止まらない)", async () => {
    const tasks = [{ bytes: 500, run: async () => "big" }];
    expect(await runLimited(tasks, { concurrency: 2, byteBudget: 100 })).toEqual(["big"]);
  });

  it("完了ごとに onDone が呼ばれる", async () => {
    const done: number[] = [];
    const tasks = [1, 2, 3].map((n) => ({ bytes: 1, run: async () => n }));
    await runLimited(tasks, { concurrency: 2, byteBudget: 10 }, (r) => done.push(r));
    expect(done.sort()).toEqual([1, 2, 3]);
  });
});
