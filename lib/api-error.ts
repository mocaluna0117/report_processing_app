/**
 * Folio のサーバー（/api/*）を呼んで失敗したときの文。純関数。
 *
 * ★Folio のログインが切れると、proxy.ts は 401（文字）を返す。「summarize API 401」では何が起きたか
 *   分からないので、ログインが切れたと言う（2026-09-24。アカウントの切り替えで、一度はログインし直すため）。
 */
export const SESSION_LOST_TEXT = "Folio のログインが切れました。画面を読み込み直してログインしてください";

/** 失敗の文（401 だけはログインが切れたと言う） */
export function apiFailureText(label: string, status: number): string {
  return status === 401 ? SESSION_LOST_TEXT : `${label} API ${status}`;
}
