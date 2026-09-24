import "server-only";
import type { Page } from "playwright-core";
import { hasTabNamed } from "./tabs";

/**
 * ログインしたあとに着いた画面の「目印」を数える（2026-09-25。Phase 0 は記録するだけ）。
 *
 * ★今のログインは「パスワード欄が消えたら成功」とみなしている（lib/rakuraku/login.ts）。
 *   それだと「パスワードの期限切れ」「ロックされました」のようなお知らせだけの画面も成功に見える。
 *   楽楽精算にIDとパスワードを登録して自動でログインするようにする前に、ログイン後の画面に
 *   いつもある目印（name="main" のフレーム・「ワークフロー」タブ）で、成功をはっきり確かめられるかを
 *   本番のログで確かめる。
 * ★読むのは数だけ（画面の文字・URL・伝票の中身は読まない・残さない）。
 */

/** どの書類の一覧も、この上部タブからたどる（lib/rakuraku/kinds.ts の menuSteps） */
export const WORKFLOW_TAB_TEXT = "ワークフロー";

export interface LandingMarkers {
  /** フレームの数（画面そのものも1つ） */
  frames: number;
  /** name="main" のフレームがあるか（楽楽精算のトップは frameset。lib/rakuraku/frames.ts） */
  mainFrame: boolean;
  /** 「ワークフロー」タブが見えているか */
  workflowTab: boolean;
  /** パスワード欄の数（全部のフレームを足す） */
  passwordFields: number;
  /** 中を読めなかったフレームの数 */
  unreadableFrames: number;
}

export async function readLandingMarkers(page: Page): Promise<LandingMarkers> {
  const frames = page.frames();
  let passwordFields = 0;
  let unreadableFrames = 0;
  for (const frame of frames) {
    const count = await frame
      .evaluate(() => document.querySelectorAll('input[type="password"]').length)
      .catch(() => -1);
    if (count < 0) unreadableFrames += 1;
    else passwordFields += count;
  }
  return {
    frames: frames.length,
    mainFrame: frames.some((f) => f.name() === "main"),
    workflowTab: await hasTabNamed(page, WORKFLOW_TAB_TEXT),
    passwordFields,
    unreadableFrames,
  };
}

/** ログに出す形（数だけ。lib/rakuraku/log.ts は n_ で始まる数しか通さない） */
export function landingCounters(m: LandingMarkers): Record<`n_${string}`, number> {
  return {
    n_frames: m.frames,
    n_main_frame: m.mainFrame ? 1 : 0,
    n_workflow_tab: m.workflowTab ? 1 : 0,
    n_password_field: m.passwordFields,
    n_unreadable_frame: m.unreadableFrames,
  };
}
