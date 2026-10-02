/**
 * 利用状況で数える名前（決まったものだけ）。画面とサーバーの両方で使う。
 *
 * ★残すのは回数と時刻だけ。顧客名・伝票No.・本文などは名前にも値にも入れない
 *   （lib/rakuraku/log.ts と同じく、自由な文字列を受け取れない型にする）。
 * ★日付は日本時間の「YYYYMMDD」。
 */
import type { KindId, RakurakuCode } from "@/lib/rakuraku/protocol";

export const USAGE_KINDS = ["tenmatsu", "senketsu", "natsuin"] as const satisfies readonly KindId[];

/** 楽楽精算の失敗の符号と、利用状況の画面に出す短い説明（★符号が増えたら型で気づく） */
export const RAKURAKU_CODE_LABELS: Readonly<Record<RakurakuCode, string>> = {
  DISABLED: "楽楽精算の取得が止まっている",
  PREVIEW_BLOCKED: "試しの版では使えない",
  BAD_REQUEST: "送った内容が不正",
  FORBIDDEN_ORIGIN: "別のサイトからの呼び出し",
  NO_PASSWORD: "パスワードが無い",
  BROWSER_LAUNCH_FAILED: "ブラウザを起動できない",
  BROWSER_BUSY: "ブラウザが混んでいる",
  TENANT_UNREACHABLE: "楽楽精算に繋がらない",
  LOGIN_FORM_NOT_FOUND: "ログインの欄が見つからない",
  LOGIN_FAILED: "ログインできない",
  LOGIN_COOLDOWN: "ログインの待ち時間中",
  SESSION_EXPIRED: "ログインが切れた",
  LOGIN_UNCONFIRMED: "ログインを確かめられない",
  LOGIN_ABORTED: "ログインを取りやめた",
  LOGIN_IN_PROGRESS: "ほかの画面でログイン中",
  LOGIN_LIMIT: "ログインの回数の上限",
  CREDENTIAL_MISSING: "IDとパスワードが未登録",
  CREDENTIAL_STALE: "このPCの登録が古い",
  CREDENTIAL_REJECTED: "前回ログインできず自動を停止中",
  CREDENTIAL_UNREADABLE: "このPCの登録を読めない",
  CREDENTIAL_NOT_SAVED: "登録を書き込めない",
  DEPT_NOT_AVAILABLE: "その部門を選べない",
  DEPT_SELECT_MISSING: "部門の選択が見つからない",
  DEPT_SWITCH_FAILED: "部門を切り替えられない",
  LIST_NOT_PERMITTED: "一覧を見る権限が無い",
  MENU_NOT_FOUND: "メニューが見つからない",
  MENU_AMBIGUOUS: "メニューを1つに決められない",
  LIST_NOT_FOUND: "一覧が見つからない",
  DETAIL_NOT_FOUND: "伝票が見つからない",
  BODY_PDF_FAILED: "伝票のPDFを取れない",
  ATTACHMENT_FAILED: "添付を取れない",
  ATTACHMENT_MISMATCH: "添付が合わない",
  TIME_BUDGET_EXCEEDED: "時間切れ",
  INTERNAL: "そのほかの失敗",
};

const RAKURAKU_CODES = Object.keys(RAKURAKU_CODE_LABELS) as RakurakuCode[];

export type UsageKind = (typeof USAGE_KINDS)[number];

export type Metric =
  /** 定期点検の報告書1件（要約の呼び出し） */
  | "teiki"
  /** アフターの受付メモ1件（要約の呼び出し） */
  | "after"
  /** 楽楽精算へのログインが通った */
  | "rk.login"
  /** 楽楽精算の一覧の読み込みが通った */
  | `rk.scan.${UsageKind}`
  /** 楽楽精算の伝票1件の取得が通った */
  | `rk.fetch.${UsageKind}`
  /** 楽楽精算の失敗（合計と、符号ごとの内訳を両方数える） */
  | "rk.fail"
  | `rk.fail.${RakurakuCode}`
  /** Gemini が答えた（要約・工事区分の画像判定・カナ） */
  | "gemini.summary"
  | "gemini.vision"
  | "gemini.kana"
  /** Gemini が失敗して、ルールの処理などに切り替えた */
  | "gemini.fail"
  /** 問い合わせを送った */
  | "contact";

const FIXED = new Set<string>([
  "teiki",
  "after",
  "rk.login",
  "rk.fail",
  "gemini.summary",
  "gemini.vision",
  "gemini.kana",
  "gemini.fail",
  "contact",
  ...USAGE_KINDS.flatMap((k) => [`rk.scan.${k}`, `rk.fetch.${k}`]),
  ...RAKURAKU_CODES.map((c) => `rk.fail.${c}`),
]);

export function isMetric(value: unknown): value is Metric {
  return typeof value === "string" && FIXED.has(value);
}

export function isUsageKind(value: unknown): value is UsageKind {
  return typeof value === "string" && (USAGE_KINDS as readonly string[]).includes(value);
}

/** 楽楽精算の一覧・取得が通ったときの名前。本文の種類が読めなければ null */
export function kindMetric(action: "scan" | "fetch", raw: unknown): Metric | null {
  const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  return isUsageKind(kind) ? `rk.${action}.${kind}` : null;
}

/** 楽楽精算の失敗の数え方（合計＋符号ごと）。★決まった符号でなければ「そのほか」に数える */
export function rakurakuFailure(code: string): Metric[] {
  return ["rk.fail", `rk.fail.${Object.hasOwn(RAKURAKU_CODE_LABELS, code) ? (code as RakurakuCode) : "INTERNAL"}`];
}

/** 失敗の内訳の名前から符号を取り出す（内訳でなければ null） */
export function failureCodeOf(metric: Metric): RakurakuCode | null {
  return metric.startsWith("rk.fail.") ? (metric.slice("rk.fail.".length) as RakurakuCode) : null;
}

/** 項目の頭の日付（「20261002:teiki」→「20261002」）。日付で始まらなければ null */
export function datePrefixOf(field: string): string | null {
  return /^(\d{8}):/.exec(field)?.[1] ?? null;
}

/** 日本時間の「YYYYMMDD」 */
export function jstDayOf(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 直近 n 日（今日を含む、新しい順）の「YYYYMMDD」 */
export function recentDays(nowMs: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => jstDayOf(nowMs - i * 86_400_000));
}

/** 見せる日数（直近30日） */
export const USAGE_DAYS = 30;
