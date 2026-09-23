"use client";

/**
 * 共有フォルダーの欄をモーダルで開く。ヘッダーの「共有フォルダー」の表示から、どの画面でも開ける
 * （lib/help-dialog.ts と同じやり方）。つながりそのものは lib/shared/connection.ts が持つ。
 */

/** ヘッダーの表示の目印（使い方の写真で印を付ける） */
export const SHARED_CHIP_ID = "shared-folder-chip";

let open = false;
const listeners = new Set<(open: boolean) => void>();

const notify = () => {
  for (const listener of listeners) listener(open);
};

export function isSharedDialogOpen(): boolean {
  return open;
}

export function subscribeSharedDialog(listener: (open: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openSharedDialog(): void {
  open = true;
  notify();
}

export function closeSharedDialog(): void {
  open = false;
  notify();
}
