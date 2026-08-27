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

/**
 * モデル1つ分の指定。thinking は null なら思考設定を付けない (既定の思考に任せる)。
 * 無料枠は「モデル単位」で1日20リクエストなので、精度を確認できたモデルを並べておき、
 * 上限に達したら次のモデルへ自動で切り替えて実質の枠を増やす。
 */
export interface ModelSpec {
  model: string;
  thinking: ThinkingConfig | null;
}

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

/**
 * "gemini-3.5-flash, gemini-3.6-flash:default, gemini-3.7-flash:LOW" のような指定を解釈する。
 * 思考レベル省略時は MINIMAL (最速)。"default" を指定するとモデル既定の思考に任せる。
 */
export function parseModelChain(spec: string): ModelSpec[] {
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [model, level] = part.split(":").map((x) => x.trim());
      if (!level || level.toUpperCase() === "MINIMAL") {
        return { model, thinking: { thinkingLevel: ThinkingLevel.MINIMAL } };
      }
      const known = THINKING_LEVELS[level.toUpperCase()];
      return { model, thinking: known ? { thinkingLevel: known } : null };
    });
}

/**
 * 画像認識 (工事区分の判定) のモデル列。実測 (見本5件) で正解5/5だったものだけを既定にしている:
 * - gemini-3.5-flash (MINIMAL): 平均2.3秒
 * - gemini-3-flash-preview (MINIMAL): 平均2.3秒
 * - gemini-3.6-flash (思考既定): 平均13.6秒。MINIMALだと4/5に落ちるため既定の思考で使う
 * lite系は手書きの丸を読めず精度が落ちるため入れない。
 */
export const GEMINI_VISION_CHAIN: ModelSpec[] = parseModelChain(
  process.env.GEMINI_VISION_MODELS ||
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash, gemini-3-flash-preview, gemini-3.6-flash:default",
);

/** 要約用のモデル列。lite系は1日の上限が緩く高速 */
export const GEMINI_SUMMARY_CHAIN: ModelSpec[] = parseModelChain(
  process.env.GEMINI_SUMMARY_MODELS ||
    process.env.GEMINI_SUMMARY_MODEL ||
    "gemini-3.5-flash-lite, gemini-3.1-flash-lite",
);

/** 施主名のカナ読み推定 (メール文用) のモデル列。省略時は要約と同じ lite 系 */
export const GEMINI_KANA_CHAIN: ModelSpec[] = process.env.GEMINI_KANA_MODELS
  ? parseModelChain(process.env.GEMINI_KANA_MODELS)
  : GEMINI_SUMMARY_CHAIN;

/** 思考トークンを最小化して待ち時間とクォータ消費を抑える (既定値) */
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
  /** 思考設定。未指定なら既定(MINIMAL)、null なら思考設定を付けない */
  thinking?: ThinkingConfig | null;
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
 * 1試行に与える最小のタイムアウト(ms)。
 * これを下回る値をAPIに渡すと "Manually set deadline is too short" で 400 になるため、
 * 予算が足りない場合は短いタイムアウトで投げるのではなく試行自体を諦める。
 */
const MIN_ATTEMPT_TIMEOUT_MS = 8000;

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
  const requested =
    opts.thinking === undefined ? THINKING_CONFIG : (opts.thinking ?? undefined);
  let thinking: ThinkingConfig | undefined = supportsThinking(opts.model)
    ? requested
    : undefined;
  let attemptNo = 0;
  let attempted = false;
  // 思考設定を外した「即時再試行」は待ち時間ゼロなので、予算判定で止めない
  let forceAttempt = false;
  let lastError: unknown = new Error("Geminiを呼び出せませんでした");

  while (attemptNo < WAITS.length + 1) {
    const remaining = deadline - Date.now();
    // 予算内にまともな試行が収まらないなら諦める (短すぎるタイムアウトはAPIに拒否される)。
    // ただし1回目は必ず投げる (予算が極端に短い設定でも動くように)
    if (attempted && !forceAttempt && remaining < MIN_ATTEMPT_TIMEOUT_MS) break;
    attempted = true;
    forceAttempt = false;
    try {
      return await attempt({
        thinkingConfig: thinking,
        timeoutMs: Math.max(
          MIN_ATTEMPT_TIMEOUT_MS,
          Math.min(opts.attemptTimeoutMs, remaining),
        ),
      });
    } catch (e) {
      lastError = e;
      // 思考設定に未対応のモデルだった → 設定を外して即再試行 (試行枠は消費しない)
      if (thinking && isInvalidArgument(e)) {
        markThinkingUnsupported(opts.model);
        thinking = undefined;
        forceAttempt = true;
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
      if (Date.now() + wait + MIN_ATTEMPT_TIMEOUT_MS > deadline) break;
      await sleep(wait);
    }
  }
  throw lastError;
}

/** 一時的にモデルが混雑している (別モデルに切り替える価値がある) か */
function isOverloaded(e: unknown): boolean {
  return /\b503\b|UNAVAILABLE|high demand|overloaded/i.test(String(e));
}

export interface ChainResult<T> {
  result: T;
  /** 実際に成功したモデル名 */
  model: string;
  /** 途中でスキップ・失敗したモデルの記録 (警告表示用) */
  skipped: string[];
}

/**
 * モデル列を順に試す。
 * 無料枠 (1日20リクエスト/モデル) を使い切ったモデルは即座に飛ばして次を使うため、
 * 精度を保ったまま実質の1日あたり処理件数を増やせる。
 */
export async function callWithModelChain<T>(
  chain: ModelSpec[],
  opts: { budgetMs: number; attemptTimeoutMs: number },
  attempt: (model: string, ctx: AttemptContext) => Promise<T>,
): Promise<ChainResult<T>> {
  const deadline = Date.now() + opts.budgetMs;
  const skipped: string[] = [];
  let lastError: unknown = new Error("利用できるGeminiモデルがありません");
  let tried = 0;

  for (const spec of chain) {
    // 上限到達済みのモデルは時間を使わずに飛ばす
    if (quotaBlockedMs(spec.model) > 0) {
      skipped.push(`${spec.model}(1日の上限に到達)`);
      lastError = new QuotaExhaustedError(spec.model, quotaBlockedMs(spec.model));
      continue;
    }
    const remaining = deadline - Date.now();
    // 次のモデルを試す時間が残っていなければ打ち切る
    if (tried > 0 && remaining < MIN_ATTEMPT_TIMEOUT_MS) break;
    tried++;
    try {
      const result = await callWithRetry(
        {
          model: spec.model,
          budgetMs: Math.max(MIN_ATTEMPT_TIMEOUT_MS, remaining),
          attemptTimeoutMs: opts.attemptTimeoutMs,
          thinking: spec.thinking,
        },
        (ctx) => attempt(spec.model, ctx),
      );
      return { result, model: spec.model, skipped };
    } catch (e) {
      lastError = e;
      if (e instanceof QuotaExhaustedError) {
        skipped.push(`${spec.model}(1日の上限に到達)`);
        continue;
      }
      if (isOverloaded(e)) {
        skipped.push(`${spec.model}(混雑)`);
        continue;
      }
      // モデル固有の問題 (未対応の引数など) の可能性があるので次のモデルも試す
      skipped.push(`${spec.model}(エラー)`);
    }
  }
  throw lastError;
}
