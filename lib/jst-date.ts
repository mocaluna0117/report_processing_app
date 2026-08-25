/**
 * 処理実行日 (日本標準時) の表記を作る。
 * 実行環境のタイムゾーンに依存しないよう Asia/Tokyo で明示的に変換する。
 */

function jstMonthDay(date: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { month: get("month"), day: get("day") };
}

/** 「最終更新日」列: 例「8月26日」(ゼロ埋めなし) */
export function formatLastUpdatedJst(date: Date = new Date()): string {
  const { month, day } = jstMonthDay(date);
  return `${month}月${day}日`;
}

/** 「備考欄」列: 例「8/26　点検報告書作成」(日付と文言の間は全角スペース) */
export function formatRemarksJst(date: Date = new Date()): string {
  const { month, day } = jstMonthDay(date);
  return `${month}/${day}　点検報告書作成`;
}
