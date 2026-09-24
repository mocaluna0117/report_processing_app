/**
 * 右上の人の形のアイコンと、押すと開く小さなメニューに出す文。純関数。
 * （画面のテスト基盤が無いので、ここで固定する）
 */
import type { SignedInMarker } from "@/lib/auth";

export interface AccountMenuView {
  /** アイコンのボタンの読み上げ名・吹き出し */
  label: string;
  /** メニューの上に出す行（名前・ID など） */
  heading: string;
  sub: string;
  /** 「アカウント」へのリンク（出さないときは null） */
  accountLink: string | null;
}

export function accountMenuView(marker: SignedInMarker): AccountMenuView {
  if (marker.legacy) {
    return {
      label: "ログイン中（前の共通の合言葉）",
      heading: "前の共通の合言葉でログインしています",
      sub: "管理者から受け取った自分のログインIDで入り直してください",
      accountLink: null,
    };
  }
  return {
    label: `アカウント（${marker.name}）`,
    heading: marker.name,
    sub: `ID: ${marker.id}${marker.admin ? "・管理者" : ""}`,
    // ★パスワードを決める前は、その画面にいるので出さない
    accountLink: marker.mustChange ? null : marker.admin ? "アカウント（パスワード・管理）" : "アカウント（パスワードを変える）",
  };
}
