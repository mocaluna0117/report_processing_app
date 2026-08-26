import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QuotaExhaustedError,
  callWithRetry,
  isDailyQuotaExhausted,
  isInvalidArgument,
  parseRetryDelayMs,
} from "@/lib/gemini-model";

/** 実際の 429 応答 (1日あたり上限) を模したエラー */
const dailyQuotaError = () =>
  new Error(
    'ApiError: {"error":{"code":429,"message":"You exceeded your current quota. Please retry in 11.1s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"11s"}]}}',
  );

const rateLimitError = () =>
  new Error('ApiError: {"error":{"code":429,"message":"Too many requests","status":"RESOURCE_EXHAUSTED"}}');

const invalidArgError = () =>
  new Error('ApiError: {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}');

// モデル名をテストごとに変えて、モジュール内のクォータ記憶を汚さない
let seq = 0;
const model = () => `test-model-${++seq}`;

describe("エラー判定", () => {
  it("1日あたりの上限切れを見分ける", () => {
    expect(isDailyQuotaExhausted(dailyQuotaError())).toBe(true);
    expect(isDailyQuotaExhausted(rateLimitError())).toBe(false);
    expect(isDailyQuotaExhausted(new Error("boom"))).toBe(false);
  });

  it("retryDelay をミリ秒で取り出す", () => {
    expect(parseRetryDelayMs(dailyQuotaError())).toBe(11000);
    expect(parseRetryDelayMs(new Error("nothing"))).toBeNull();
  });

  it("思考設定の非対応エラーを見分ける", () => {
    expect(isInvalidArgument(invalidArgError())).toBe(true);
    expect(isInvalidArgument(rateLimitError())).toBe(false);
  });
});

describe("callWithRetry", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("成功すればそのまま返す", async () => {
    const r = await callWithRetry({ model: model(), budgetMs: 5000, attemptTimeoutMs: 1000 }, async () => "ok");
    expect(r).toBe("ok");
  });

  it("既定では思考設定を渡す", async () => {
    let seen: unknown;
    await callWithRetry({ model: model(), budgetMs: 5000, attemptTimeoutMs: 1000 }, async (ctx) => {
      seen = ctx.thinkingConfig;
      return 1;
    });
    expect(seen).toEqual({ thinkingLevel: "MINIMAL" });
  });

  it("思考設定が非対応なら試行枠を消費せず即再試行し、以降は付けない", async () => {
    const m = model();
    const seen: (unknown)[] = [];
    const t0 = Date.now();
    const r = await callWithRetry({ model: m, budgetMs: 5000, attemptTimeoutMs: 1000 }, async (ctx) => {
      seen.push(ctx.thinkingConfig);
      if (ctx.thinkingConfig) throw invalidArgError();
      return "ok";
    });
    expect(r).toBe("ok");
    expect(seen).toEqual([{ thinkingLevel: "MINIMAL" }, undefined]);
    expect(Date.now() - t0).toBeLessThan(500); // 待たずに再試行している

    // 同じモデルの次回呼び出しでは最初から思考設定なし
    const seen2: unknown[] = [];
    await callWithRetry({ model: m, budgetMs: 5000, attemptTimeoutMs: 1000 }, async (ctx) => {
      seen2.push(ctx.thinkingConfig);
      return "ok";
    });
    expect(seen2).toEqual([undefined]);
  });

  it("1日あたりの上限切れは待たずに諦め、以降の呼び出しも即座に失敗する", async () => {
    const m = model();
    let calls = 0;
    const t0 = Date.now();
    await expect(
      callWithRetry({ model: m, budgetMs: 20000, attemptTimeoutMs: 1000 }, async () => {
        calls++;
        throw dailyQuotaError();
      }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(calls).toBe(1); // リトライしない
    expect(Date.now() - t0).toBeLessThan(500);

    // 記憶しているので2回目はAPIを呼ばない
    let calls2 = 0;
    await expect(
      callWithRetry({ model: m, budgetMs: 20000, attemptTimeoutMs: 1000 }, async () => {
        calls2++;
        return "ok";
      }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(calls2).toBe(0);
  });

  it("レート制限(429)はリトライする", async () => {
    let calls = 0;
    const r = await callWithRetry({ model: model(), budgetMs: 20000, attemptTimeoutMs: 1000 }, async () => {
      calls++;
      if (calls < 2) throw rateLimitError();
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(2);
  });

  it("429以外の4xxは即座に諦める", async () => {
    let calls = 0;
    await expect(
      callWithRetry({ model: model(), budgetMs: 20000, attemptTimeoutMs: 1000 }, async () => {
        calls++;
        throw new Error('ApiError: {"error":{"code":404,"message":"model not found"}}');
      }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("予算が足りなければ待たずに打ち切る (フォールバックへ渡す)", async () => {
    let calls = 0;
    const t0 = Date.now();
    await expect(
      callWithRetry({ model: model(), budgetMs: 1200, attemptTimeoutMs: 500 }, async () => {
        calls++;
        throw rateLimitError();
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // 1.5秒待つ余裕がないので再試行しない
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("試行ごとのタイムアウトは残り予算を超えない", async () => {
    const seen: number[] = [];
    await callWithRetry({ model: model(), budgetMs: 3000, attemptTimeoutMs: 20000 }, async (ctx) => {
      seen.push(ctx.timeoutMs);
      return 1;
    });
    expect(seen[0]).toBeLessThanOrEqual(3000);
  });

  it("予算が極端に短くても1回は必ず投げる", async () => {
    let calls = 0;
    const r = await callWithRetry({ model: model(), budgetMs: 100, attemptTimeoutMs: 5000 }, async () => {
      calls++;
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });
});
