/**
 * このページの中で走っている取得（種類をまたいで1本）。
 *
 * ★lib/tenmatsu/local/client.ts から**この1本だけ**を切り出した小さなモジュール。
 *   client.ts は PDF の結合や記録の読み書きまで引くので、ヘッダー（どの画面でも読み込む）から
 *   「いま取得中か」を聞くためだけに読み込むと重すぎる。型は `import type` なので、
 *   このモジュールを読み込んでも job.ts の中身は読み込まれない。
 * ★client.ts は今までどおり hasActiveRun / activeRunKind / resetActiveRun を再 export するので、
 *   これまでの呼び元は変えなくてよい。
 */
import type { KindId } from "@/lib/rakuraku/kinds";
import type { RunHandle } from "./job";

export interface ActiveRun {
  kind: KindId;
  handle: RunHandle;
}

let activeRun: ActiveRun | null = null;

/** いま控えている取得（走り終わったものも含む。状態を見たいときに使う） */
export function currentActiveRun(): ActiveRun | null {
  return activeRun;
}

export function setActiveRun(next: ActiveRun | null): void {
  activeRun = next;
}

/** このページの中で取得が走っているか（種類を渡すとその種類だけ） */
export function hasActiveRun(kind?: KindId): boolean {
  if (!activeRun || activeRun.handle.snapshot().state !== "running") return false;
  return kind === undefined || activeRun.kind === kind;
}

/** 走っている取得の種類（無ければ null） */
export function activeRunKind(): KindId | null {
  return activeRun && hasActiveRun() ? activeRun.kind : null;
}

/** テスト用。走っている取得の控えを消す */
export function resetActiveRun(): void {
  activeRun = null;
}
