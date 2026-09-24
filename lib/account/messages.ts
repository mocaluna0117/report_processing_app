/**
 * ログイン・アカウントの画面に出す文。純関数と定数だけ（画面とサーバーの両方から読む）。
 * ★ログインに失敗したときは、ID が無いのか・パスワードが違うのかを言い分けない（ID を当てられないように）。
 */
export type LoginErrorCode =
  | "1"
  | "locked"
  | "disabled"
  | "temp-expired"
  | "unavailable"
  | "origin"
  | "broken";

const LOGIN_ERRORS: Record<LoginErrorCode, string> = {
  "1": "ログインIDかパスワードが違います",
  locked: "失敗が続いたため、しばらくログインできません。15分ほど待ってからもう一度入れてください",
  disabled: "このアカウントは止められています。管理者に確かめてください",
  "temp-expired": "仮のパスワードの期限が切れています。管理者に新しい仮のパスワードを発行してもらってください",
  unavailable: "いまログインを確かめられません。少し待ってからもう一度入れてください",
  origin: "別のページから送られたため、ログインしませんでした。この画面から入り直してください",
  broken: "Folio のログインの設定が足りないため、使えません（管理者へ連絡してください）",
};

/** URL の error=… を文にする（知らない値は出さない） */
export function loginErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  return (LOGIN_ERRORS as Record<string, string>)[code] ?? null;
}

export const LOGIN_EXPIRED_TEXT = "ログインが切れました。もう一度ログインしてください。";
export const SIGNED_OUT_TEXT = "ログアウトしました。";
export const LOGIN_LEAD_TEXT = "顧客情報を扱うため、一人ずつのアカウントで保護しています。";
export const FORGOT_PASSWORD_TEXT =
  "パスワードを忘れたときは、管理者に仮のパスワードを発行してもらってください。";

/** パスワードを変えたあとの文 */
export const PASSWORD_CHANGED_TEXT =
  "パスワードを変えました。ほかの端末でログインしていた分は、5分ほどで切れます。";
/** 仮のパスワードで入ったときの先頭の文 */
export const MUST_CHANGE_TEXT =
  "仮のパスワードでログインしました。続けて使うには、自分のパスワードを決めてください。";

/** 仮のパスワードを出すときの注意 */
export const TEMP_PASSWORD_NOTE =
  "この仮のパスワードは、いま1回だけ表示します。本人に直接（口頭か手渡しで）伝えてください。7日で切れます。";
