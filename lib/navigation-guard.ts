"use client";

// 処理中に画面を切り替えると、完了していない分の結果が失われる。
// モード切替のリンクから確認を出すため、現在の状態をモジュール変数で共有する。

let message: string | null = null;

/** 処理を始めたら理由を設定し、終わったら null に戻す */
export function setNavigationGuard(reason: string | null): void {
  message = reason;
}

export function getNavigationGuard(): string | null {
  return message;
}
