import { ThinkingLevel, type ThinkingConfig } from "@google/genai";

/**
 * Gemini の使用モデル・思考設定・リトライ制御 (サーバー側のみ参照)。
 *
 * 実測 (見本5件, 2026-08-26):
 * - 画像認識(工事区分): gemini-3.6-flash/思考既定 は正解5/5だが平均13.6秒。
 *   gemini-3.5-flash + thinkingLevel:MINIMAL は正解5/5で平均2.3秒 → 約6倍速。
 *   flash-lite 系は手書きの丸を読めず精度が落ちるため画像認識には使わない。
 * - 要約: gemini-3.5-flash-lite + MINIMAL が平均1.1秒で品質も良好 (約9倍速)。
 * - 無料枠は flash系(非lite)が1日20リクエストと厳しい。要約と画像認識で別モデルにして
 *   クォータを分散し、上限に当たったら即座にフォールバックへ落とす。
 */

/** 画像認識 (工事区分の判定) 用。精度が要るので lite は使わない */
export const GEMINI_VISION_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

/** 要約 (アフター受付内容) 用。未設定なら lite (1日の上限が緩く高速) */
export const GEMINI_SUMMARY_MODEL =
  process.env.GEMINI_SUMMARY_MODEL || "gemini-3.5-flash-lite";

/** 思考トークンを最小化して待ち時間とクォータ消費を抑える */
export const THINKING_CONFIG: ThinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };

/** 思考設定が原因のリクエスト拒否か (モデル非対応時のフォールバック判定用) */
export function isInvalidArgument(e: unknown): boolean {
  return /INVALID_ARGUMENT|invalid argument/i.test(String(e));
}

// --- モデルごとの thinkingLevel 対応可否 (プロセス内で記憶し、無駄な1回目を繰り返さない) ---
const thinkingUnsupported = new Set<string>();
export function supportsThinking(model: string): boolean {
  return !thinkingUnsupported.has(model);
}
export function markThinkingUnsupported(model: string): void {
  thinkingUnsupported.add(model);
}

// --- 無料枠 (1日あたり) の上限に当たったモデルを記憶し、解除時刻まで叩かない ---
const quotaBlockedUntil = new Map<string, number>();

/** 1日あたりの上限切れ (リトライしても回復しない種類の429) か */
export function isDailyQuotaExhausted(e: unknown): boolean {
  const s = String(e);
  if (!/429|RESOURCE_EXHAUSTED/.test(s)) return false;
  // 例: quotaId "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
  return /PerDay|per day|current quota/i.test(s);
}

/** エラー本文の retryDelay ("11s" 等) をミリ秒で返す */
export function parseRetryDelayMs(e: unknown): number | null {
  const s = String(e);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(s) ?? /retry in (\d+(?:\.\d+)?)s/i.exec(s);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export function noteQuotaExhausted(model: string, ms: number): void {
  quotaBlockedUntil.set(model, Date.now() + Math.max(1000, ms));
}

/** クォータ切れで待機中なら残りミリ秒、そうでなければ0 */
export function quotaBlockedMs(model: string): number {
  const until = quotaBlockedUntil.get(model) ?? 0;
  return Math.max(0, until - Date.now());
}

export class QuotaExhaustedError extends Error {
  constructor(model: string, waitMs: number) {
    const min = Math.ceil(waitMs / 60000);
    super(
      `Gemini APIの無料枠(モデル ${model} の1日あたりの上限)を使い切っています。` +
        `約${min}分後に再試行できます。従量課金を有効にするか、手動で入力してください`,
    );
    this.name = "QuotaExhaustedError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  model: string;
  /** この呼び出し全体の予算(ms)。サーバーレスの maxDuration より短くする */
  budgetMs: number;
  /** 1試行あたりのタイムアウト(ms) */
  attemptTimeoutMs: number;
}

export interface AttemptContext {
  /** モデルが対応していれば思考設定、非対応と判明していれば undefined */
  thinkingConfig?: ThinkingConfig;
  /** この試行に使うタイムアウト(ms) */
  timeoutMs: number;
}

/** リトライ間の待ち時間 (ms)。全体で最大3試行 */
const WAITS = [1500, 4000];

/**
 * 締切付きのリトライ制御。
 * - 1日あたりのクォータ切れは即座に諦める (待っても回復しないため)
 * - thinkingLevel 非対応が判明したら試行枠を消費せず即再試行し、以降そのモデルでは付けない
 * - 予算内に次の試行が収まらなければ打ち切り、呼び出し側のフォールバックへ渡す
 */
export async function callWithRetry<T>(
  opts: RetryOptions,
  attempt: (ctx: AttemptContext) => Promise<T>,
): Promise<T> {
  const blocked = quotaBlockedMs(opts.model);
  if (blocked > 0) throw new QuotaExhaustedError(opts.model, blocked);

  const deadline = Date.now() + opts.budgetMs;
  let thinking: ThinkingConfig | undefined = supportsThinking(opts.model)
    ? THINKING_CONFIG
    : undefined;
  let attemptNo = 0;
  let attempted = false;
  let lastError: unknown = new Error("Geminiを呼び出せませんでした");

  while (attemptNo < WAITS.length + 1) {
    const remaining = deadline - Date.now();
    // 予算切れなら再試行はしない。ただし1回目は必ず投げる (予算が極端に短い設定でも動くように)
    if (attempted && remaining <= 1000) break;
    attempted = true;
    try {
      return await attempt({
        thinkingConfig: thinking,
        timeoutMs: Math.max(1000, Math.min(opts.attemptTimeoutMs, remaining)),
      });
    } catch (e) {
      lastError = e;
      // 思考設定に未対応のモデルだった → 設定を外して即再試行 (試行枠は消費しない)
      if (thinking && isInvalidArgument(e)) {
        markThinkingUnsupported(opts.model);
        thinking = undefined;
        continue;
      }
      if (isDailyQuotaExhausted(e)) {
        const wait = parseRetryDelayMs(e) ?? 60_000;
        noteQuotaExhausted(opts.model, wait);
        throw new QuotaExhaustedError(opts.model, wait);
      }
      const msg = String(e);
      // 4xx (429以外) はリトライしても無駄
      if (/\b4\d{2}\b/.test(msg) && !/429/.test(msg)) throw e;

      attemptNo++;
      if (attemptNo > WAITS.length) break;
      const wait = Math.min(parseRetryDelayMs(e) ?? WAITS[attemptNo - 1], WAITS[attemptNo - 1]);
      // 待ってから1試行する時間が残っていなければ打ち切る
      if (Date.now() + wait + 1000 >= deadline) break;
      await sleep(wait);
    }
  }
  throw lastError;
}
