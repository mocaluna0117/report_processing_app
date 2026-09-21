"use client";

/**
 * 「使い方」をモーダルで開く。ヘッダーの「使い方」ボタンと、各画面の手順バーの
 * 「使い方を見る」の両方から同じモーダルを開けるように、モジュールで状態を共有する
 * （lib/navigation-guard.ts と同じやり方）。
 */

export interface HelpDialogState {
  open: boolean;
  /** 開いたときに選んでおく画面（lib/help.ts の HelpSection.slug）。null は最初の画面 */
  slug: string | null;
}

let state: HelpDialogState = { open: false, slug: null };
const listeners = new Set<(state: HelpDialogState) => void>();

const notify = () => {
  for (const listener of listeners) listener(state);
};

export function getHelpDialogState(): HelpDialogState {
  return state;
}

export function subscribeHelpDialog(listener: (state: HelpDialogState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** slug を省くと、直前に選んでいた画面（無ければ最初の画面）のまま開く */
export function openHelp(slug: string | null = state.slug): void {
  state = { open: true, slug };
  notify();
}

export function closeHelp(): void {
  state = { ...state, open: false };
  notify();
}
