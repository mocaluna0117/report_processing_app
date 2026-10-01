import type { Page } from "playwright-core";

/**
 * ブラウザ（Playwright）の例外から、**決まった形の符号だけ**を取り出す。画面とログに添える。
 *
 * ★以前は `e.name` だけを出していたので、画面もログも「（Error）」になり、
 *   接続が切られたのか・ページが落ちたのか・別の移動に割り込まれたのかを見分けられなかった
 *   （2026-09-28、取得が1秒で失敗し続けたのに原因を決められなかった）。
 * ★例外の本文そのものは返さない。本文には移動先の URL（クエリに伝票No.）が入るので、
 *   ここで作った符号以外は画面にもログにも出さない。
 */
export type FailureSign = string;

/** 符号として通す形。log.ts もこれで確かめる（自由な文字列をログに出さない） */
export const FAILURE_SIGN_PATTERN = /^[A-Za-z][A-Za-z0-9_:]{0,63}$/;

/** ブラウザが落ちたときの符号。★この2つは「楽楽精算に繋がらない」ではなく、こちらのブラウザが消えたもの */
export const BROWSER_GONE_SIGNS: ReadonlySet<FailureSign> = new Set(["TARGET_CLOSED", "PAGE_CRASHED"]);

const RULES: ReadonlyArray<readonly [RegExp, FailureSign]> = [
  [/page crashed/i, "PAGE_CRASHED"],
  [/\b(Target|Browser|Page)( page, context or browser)? (has been )?closed/i, "TARGET_CLOSED"],
  [/interrupted by another navigation/i, "NAV_INTERRUPTED"],
  [/Download is starting/i, "DOWNLOAD_STARTED"],
  [/Timeout \d+ms exceeded/i, "TIMEOUT"],
];

/** Playwright がブラウザの落ちた例外の末尾に付ける、Chromium の出力の見出し */
const BROWSER_LOGS = "\nBrowser logs:";

/** 例外の本文を「Playwright の文」と「Chromium の出力」に分ける */
function splitBrowserLogs(message: string): { head: string; logs: string } {
  const at = message.indexOf(BROWSER_LOGS);
  return at < 0 ? { head: message, logs: "" } : { head: message.slice(0, at), logs: message.slice(at) };
}

export function failureSign(error: unknown): FailureSign {
  if (!(error instanceof Error)) return "Error";
  // ★Chromium の出力（Browser logs）の中の net::ERR_… を、移動の失敗と取り違えない
  const { head: message } = splitBrowserLogs(error.message ?? "");
  // Chromium の通信の失敗（net::ERR_CONNECTION_RESET など）は、その符号がいちばん確か
  const net = /net::ERR_[A-Z0-9_]+/.exec(message);
  if (net) return net[0];
  if (error.name === "TimeoutError") return "TIMEOUT";
  for (const [pattern, sign] of RULES) if (pattern.test(message)) return sign;
  return FAILURE_SIGN_PATTERN.test(error.name) ? error.name : "Error";
}

/**
 * ブラウザが落ちたときの手がかり。★どれも数か決まった形の符号だけ（ログに出す）。
 *
 * 2026-10-01、取得（scan / fetch）だけが開始から1秒以内に TARGET_CLOSED で止まり続けた。
 * メモリ不足で強制終了されたのか（SIGKILL）、Chromium 自体が落ちたのかを見分けるために残す。
 *
 * ★interface ではなく type にする（log.ts の LogFields にそのまま渡せるように）
 */
export type CrashSigns = {
  /** プロセスを止めたシグナル（SIGKILL など） */
  exit?: string;
  /** プロセスの終了コード */
  n_exit_code?: number;
  /** Chromium の出力のうち、メモリ不足を示す行の数 */
  n_oom_lines?: number;
  /** Chromium の出力のうち、FATAL / Check failed の行の数 */
  n_fatal_lines?: number;
};

/** シグナルとして通す形 */
export const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,16}$/;

/**
 * 例外に付いた Chromium の出力（Browser logs）から、決まった手がかりだけを数える。
 * ★出力の文そのものは返さない（読み込んだ画面の URL が混ざりうる）。
 */
export function crashSigns(error: unknown): CrashSigns {
  if (!(error instanceof Error)) return {};
  const { logs } = splitBrowserLogs(error.message ?? "");
  if (!logs) return {};
  const out: CrashSigns = {};
  const exit = /<process did exit: exitCode=(-?\d+|null), signal=([A-Z0-9]+|null)>/.exec(logs);
  if (exit) {
    if (exit[1] !== "null") out.n_exit_code = Number(exit[1]);
    if (SIGNAL_PATTERN.test(exit[2])) out.exit = exit[2];
  }
  const lines = logs.split("\n");
  const oom = lines.filter((l) => /out of memory|\bOOM\b|Cannot allocate memory|ENOMEM/i.test(l)).length;
  const fatal = lines.filter((l) => /\bFATAL\b|Check failed/.test(l)).length;
  if (oom > 0) out.n_oom_lines = oom;
  if (fatal > 0) out.n_fatal_lines = fatal;
  return out;
}

/**
 * ページかブラウザが閉じているか（落ちたか、こちらが閉じたか）。
 * ★要素を数える処理は失敗を 0 に丸めているので、これで確かめないと
 *   「ブラウザが落ちた」を「プルダウンが無い」「ログイン画面ではない」と取り違える。
 */
export function isBrowserGone(page: Page): boolean {
  if (page.isClosed()) return true;
  const browser = page.context().browser();
  return browser !== null && !browser.isConnected();
}
