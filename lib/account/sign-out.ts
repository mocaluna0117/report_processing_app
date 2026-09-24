"use client";

/**
 * Folio からログアウトしたとき・ログイン画面に来たときに、このタブに残っているものを消す。
 *
 * ★このタブの楽楽精算のログイン（sessionStorage の控え）は、消さないと次にログインした人に戻ってしまう
 *   （共有の端末で、前の人の楽楽精算に入れてしまう）。
 * ★ログイン画面へは、ログインが切れて画面の切り替え（ページを読み込み直さない移動）で来ることもある。
 *   ヘッダー（components/mode-nav.tsx）が pathname を見て呼ぶ。
 * ★楽楽精算のログインIDの覚え（このブラウザの保存）は消さない（1人1台の決定。2026-09-24）。
 */
import { clearContactDraft } from "@/lib/contact/dialog";
import { clearLoginDismissal } from "@/lib/rakuraku-login-dialog";
import { forgetLogin } from "@/lib/tenmatsu/local/session";

export function clearTabForAnotherPerson(): void {
  forgetLogin();
  clearLoginDismissal();
  clearContactDraft();
}
