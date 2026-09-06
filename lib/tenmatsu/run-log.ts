// 取得中にPCのコンソールへ出た行を、画面に出せる形で貯めるための純関数。
//
// PC側の /status?since=N が「その番号より後の行」を返すので、それを順に足していく。
// ★このブラウザのメモリの中にだけ置く (IndexedDB にも folio のサーバーにも送らない)。
//   行にはログインID・PCのパス・監督/営業名・添付のファイル名 (施主名を含むことがある)
//   が入るため、次の実行を始めるか再読み込みすれば消えるようにしている。
import type { RunLogLine, StatusPayload } from "@/lib/tenmatsu/client";

/**
 * 画面に残す行数の上限。PC側も同じ数で古い行から捨てているので、
 * ここを増やしてもPCに無い行は戻ってこない。
 */
export const RUN_LOG_MAX_LINES = 2000;

export function isRunLogLine(v: unknown): v is RunLogLine {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.seq === "number" && Number.isFinite(o.seq) && typeof o.text === "string";
}

/**
 * /status の応答から新しい行を足す。
 * log が入っていない応答 (古いサーバー・since 無しの呼び方・/run の応答) では
 * **同じ配列をそのまま返す** (毎回作り直すと画面が無駄に描き直される)。
 */
export function appendRunLog(prev: RunLogLine[], status: StatusPayload): RunLogLine[] {
  if (!Array.isArray(status.log)) return prev;
  const add = status.log.filter(isRunLogLine);
  if (add.length === 0) return prev;
  const next = [...prev, ...add];
  return next.length > RUN_LOG_MAX_LINES ? next.slice(next.length - RUN_LOG_MAX_LINES) : next;
}

/**
 * 次に取りに行く位置。
 * ★最後の行の seq ではなく**応答の log_seq** を使う。こうしておくと、
 *   新しい実行で番号が0から振り直されても、PC側が「since が大きすぎる」と見て
 *   全行を返してくれるので1回のポーリングで追いつける。
 * log_seq を返さない古いサーバーでは今の値を持ち続ける (行も来ないので増えない)。
 */
export function nextLogSince(status: StatusPayload, current: number): number {
  return typeof status.log_seq === "number" ? status.log_seq : current;
}

/** 行の色分け。字下げが混ざる (「  OK 保存: …」「  ! 動画・音声のため…」) ので先頭の空白は無視する */
export function runLogTone(text: string): "ok" | "warn" | "plain" {
  const head = text.trimStart();
  if (head.startsWith("OK ")) return "ok";
  if (head.startsWith("!")) return "warn";
  return "plain";
}
