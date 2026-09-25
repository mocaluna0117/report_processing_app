/**
 * 右上の人の形のアイコンと、押すと開く小さなメニューに出す文。純関数。
 * （画面のテスト基盤が無いので、ここで固定する）
 */
import type { SignedInMarker } from "@/lib/auth";

export const FOLIO_LOGOUT_LABEL = "Folio からログアウト";
export const FOLIO_LOGOUT_TITLE =
  "Folio 自体のログインを解除します。このタブの楽楽精算のログインも一緒に忘れます（登録した楽楽精算のIDとパスワードは、このPCに残ります）。共有の端末では作業後に押してください";

/** 問い合わせを開く項目（2026-09-25 にヘッダーの段から、このメニューへ移した） */
export const CONTACT_MENU_LABEL = "問い合わせ";

export interface AccountMenuView {
  /** アイコンのボタンの読み上げ名・吹き出し */
  label: string;
  /** アイコンの横に出す名前（ひと目で誰か分かるように） */
  short: string;
  /** メニューの上に出す行（名前・ID など） */
  heading: string;
  sub: string;
  /** 「アカウント」へのリンク（出さないときは null） */
  accountLink: string | null;
  /**
   * 問い合わせを開く項目（出さないときは null）。
   * ★パスワードを決める前の人には出さない（問い合わせの口を使えない・小窓も置かれていない）
   */
  contact: string | null;
}

export function accountMenuView(marker: SignedInMarker): AccountMenuView {
  return {
    label: `アカウント（${marker.name}）`,
    short: marker.name,
    heading: marker.name,
    // ★「ID」だけだと何のIDか分からないので「ログインID」と書く（2026-09-25）
    sub: `ログインID: ${marker.id}${marker.admin ? "・管理者" : ""}`,
    // ★パスワードを決める前は、その画面にいるので出さない
    accountLink: marker.mustChange ? null : marker.admin ? "アカウント（パスワード・楽楽精算・管理）" : "アカウント（パスワード・楽楽精算）",
    contact: marker.mustChange ? null : CONTACT_MENU_LABEL,
  };
}
