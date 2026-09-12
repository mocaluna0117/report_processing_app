import "server-only";
import { RakurakuError } from "./errors";
import { GuardError } from "./guard";
import { type Stage, log } from "./log";
import type { ErrorEvent, ProgressStage, RakurakuEvent } from "./protocol";
import { SessionError } from "./session";

/**
 * 進み具合と結果を、行ごとの JSON（NDJSON）で流す応答。
 *
 * ★HTTP の状態は常に 200。**成否は最後の行**（`done` か `error`）で表す。
 *   関数が途中で打ち切られたときにどちらも届かないので、ブラウザは「途中で切れた」と分かる。
 * ★ブラウザが接続を切ったら `signal` が立つ。楽楽精算を操作しているブラウザはすぐ閉じること
 *   （待っている人がいないのに Vercel の実行時間を使い続けない）。
 */
export interface EventSink {
  /** 1行送る。★大きな行（ファイル）は await して、相手が読むのを待つ */
  send(event: RakurakuEvent): Promise<void>;
  /** 移植元が画面に print していた1行。順番は保たれるので待たなくてよい */
  log(line: string): void;
  progress(stage: ProgressStage, message: string): void;
  /** ブラウザが接続を切ったときに呼ぶ処理を登録する（すでに切れていればすぐ呼ぶ） */
  onAbort(fn: () => void): void;
  readonly signal: AbortSignal;
}

export interface NdjsonOptions {
  /** Vercel のログに出す段階名（成否と所要時間だけを出す） */
  stage: Stage;
  /** 所要時間を数え始めた時刻 */
  startedAt?: number;
  /** 何も流れない間に生存確認を送る間隔。途中の中継が黙った接続を切らないように */
  pingIntervalMs?: number;
}

export const PING_INTERVAL_MS = 10_000;

/** 例外を、ブラウザへ返す最後の行にする。★資格情報が混ざらないよう、知らない例外は1行目だけを短く */
export function toErrorEvent(error: unknown): ErrorEvent {
  if (error instanceof RakurakuError) {
    return {
      type: "error",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      sessionLost: error.sessionLost,
      ...(error.available ? { available: error.available } : {}),
    };
  }
  if (error instanceof GuardError) {
    return { type: "error", code: error.code, message: error.message, retryable: false, sessionLost: false };
  }
  if (error instanceof SessionError) {
    // 鍵が無いのは利用者のせいではない。ログインし直させても直らないので、設定の問題として返す
    return error.reason === "secret"
      ? { type: "error", code: "DISABLED", message: error.message, retryable: false, sessionLost: false }
      : { type: "error", code: "SESSION_EXPIRED", message: error.message, retryable: false, sessionLost: true };
  }
  const first = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "";
  return { type: "error", code: "INTERNAL", message: first || "失敗しました", retryable: false, sessionLost: false };
}

export function ndjsonResponse(
  request: Request,
  run: (sink: EventSink) => Promise<void>,
  options: NdjsonOptions,
): Response {
  const startedAt = options.startedAt ?? Date.now();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const aborter = new AbortController();
  const abortHandlers: (() => void)[] = [];

  aborter.signal.addEventListener(
    "abort",
    () => {
      for (const fn of abortHandlers.splice(0)) {
        try {
          fn();
        } catch {
          /* 片付けの失敗で止めない */
        }
      }
    },
    { once: true },
  );
  if (request.signal.aborted) aborter.abort();
  else request.signal.addEventListener("abort", () => aborter.abort(), { once: true });

  // 書き込みは1本の鎖につないで、送った順に届ける（進捗の行が結果の行を追い越さない）
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const write = (event: RakurakuEvent): Promise<void> => {
    chain = chain.then(async () => {
      if (closed) return;
      try {
        await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch {
        // 読む側がいなくなった＝ブラウザが接続を切った
        closed = true;
        aborter.abort();
      }
    });
    return chain;
  };

  const sink: EventSink = {
    send: write,
    log: (line) => void write({ type: "log", line }),
    progress: (stage, message) => void write({ type: "progress", stage, message }),
    onAbort: (fn) => {
      if (aborter.signal.aborted) fn();
      else abortHandlers.push(fn);
    },
    signal: aborter.signal,
  };

  const ping = setInterval(() => void write({ type: "ping" }), options.pingIntervalMs ?? PING_INTERVAL_MS);

  void (async () => {
    try {
      await run(sink);
      await write({ type: "done" });
      log(options.stage, { ok: true, ms_total: Date.now() - startedAt });
    } catch (error) {
      const event = toErrorEvent(error);
      await write(event);
      // 接続が切れて後片付けした結果の失敗は、不具合（INTERNAL）と見分けられるように記録する
      const code = aborter.signal.aborted ? "ABORTED" : event.code;
      log(options.stage, { ok: false, code, ms_total: Date.now() - startedAt });
    } finally {
      clearInterval(ping);
      await chain;
      closed = true;
      await writer.close().catch(() => undefined);
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
