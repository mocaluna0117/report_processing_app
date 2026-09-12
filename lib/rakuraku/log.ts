import "server-only";

/**
 * Vercel のログに出してよいものだけを受け取る記録係。
 *
 * ★ 施主の個人情報・伝票No.・氏名・ファイル名・URL のクエリは**絶対に出さない**。
 *   自由な文字列を受け取れないよう、型で段階名と数値だけに絞ってある
 *   （うっかり `log("伝票 " + no)` と書けない）。
 * ★ ログの保存期間は Hobby で1時間だが、短いからといって出してよい訳ではない。
 */
export type Stage =
  | "route"
  | "launch"
  | "navigate"
  | "login"
  | "list"
  | "detail"
  | "download"
  | "close";

type Counters = Record<`n_${string}` | `ms_${string}`, number>;

export interface LogFields extends Partial<Counters> {
  /** 失敗したときの分類。文章ではなく決まった符号だけ */
  code?: string;
  /** 成否 */
  ok?: boolean;
}

export function log(stage: Stage, fields: LogFields = {}): void {
  const safe: Record<string, number | string | boolean> = { stage };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === "code" && typeof value === "string") safe.code = value;
    else if (key === "ok" && typeof value === "boolean") safe.ok = value;
    else if (typeof value === "number" && (key.startsWith("n_") || key.startsWith("ms_"))) {
      safe[key] = value;
    }
    // それ以外は黙って捨てる (個人情報が紛れ込む経路を残さない)
  }
  console.log(JSON.stringify(safe));
}

/** URL を記録するときは origin とパスだけにする (クエリに伝票No.が入る) */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(不正なURL)";
  }
}
