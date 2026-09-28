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

const RULES: ReadonlyArray<readonly [RegExp, FailureSign]> = [
  [/page crashed/i, "PAGE_CRASHED"],
  [/\b(Target|Browser|Page)( page, context or browser)? (has been )?closed/i, "TARGET_CLOSED"],
  [/interrupted by another navigation/i, "NAV_INTERRUPTED"],
  [/Download is starting/i, "DOWNLOAD_STARTED"],
  [/Timeout \d+ms exceeded/i, "TIMEOUT"],
];

export function failureSign(error: unknown): FailureSign {
  if (!(error instanceof Error)) return "Error";
  const message = error.message ?? "";
  // Chromium の通信の失敗（net::ERR_CONNECTION_RESET など）は、その符号がいちばん確か
  const net = /net::ERR_[A-Z0-9_]+/.exec(message);
  if (net) return net[0];
  if (error.name === "TimeoutError") return "TIMEOUT";
  for (const [pattern, sign] of RULES) if (pattern.test(message)) return sign;
  return FAILURE_SIGN_PATTERN.test(error.name) ? error.name : "Error";
}
