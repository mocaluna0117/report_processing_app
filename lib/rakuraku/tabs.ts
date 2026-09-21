import type { Page } from "playwright-core";

/**
 * ログインしたアカウントに「閲覧」タブがあるか＝**自部門の伝票を検索できる権限か**を見る。
 *
 * ★アカウントによって使える画面が違う。「閲覧」タブがある人は自部門検索（jibumon）から、
 *   無い人は「ワークフロー」の申請検索（shinsei）から取る。今までは閲覧側を先に試して
 *   失敗したら切り替えていたが、**ログインした時点で分かる**ので、その1回の無駄をなくす。
 * ★この判定を間違えても伝票を取り違えることはない。経路が違えば一覧に出る範囲も変わるので、
 *   **どの経路で取ったかは必ず画面に出す**（申請検索は「自分の申請分だけ」と琥珀色で伝える）。
 *   開けなかったときは今までどおりもう一方の経路へ切り替える（lib/rakuraku/navigation.ts の gotoList）。
 * ★押さない・書き換えない。タブが**ある**ことを見るだけ。
 */

/** 上部タブの文字。実画面は「閲覧」 */
export const VIEW_TAB_TEXT = "閲覧";

/** 空白（全角も）を落として見比べる。「閲 覧」のような字間の入れ方に引っかからないため */
export function normalizeTabText(text: string): string {
  return text.replace(/[\s　]+/g, "");
}

/**
 * タブの文字がその名前そのものか。
 * ★「閲覧権限がありません」のような**文の一部には反応しない**（そのままだと、
 *   権限が無い画面の文言を見て「権限がある」と読み違える）。
 */
export function isTabNamed(text: string, name: string): boolean {
  return normalizeTabText(text) === normalizeTabText(name);
}

/**
 * トップ画面の上部タブに「閲覧」があるか。
 * 見つからない・読めないときは false（＝申請検索から取る。開けなければ切り替わる）。
 */
export async function hasViewTab(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((name: string) => {
        const flat = (s: string) => s.replace(/[\s　]+/g, "");
        const target = flat(name);
        for (const el of Array.from(document.querySelectorAll("a, button, [onclick], [role=tab]"))) {
          const text = ((el as HTMLElement).innerText || el.textContent || "").trim();
          // 押せる場所にその文字だけが載っているものを数える（文の一部は数えない）
          if (flat(text) !== target) continue;
          // 隠れている（別のタブの中にたたまれている）ものは「ある」と数えない
          if (el.getClientRects().length === 0) continue;
          return true;
        }
        return false;
      }, VIEW_TAB_TEXT)
      .catch(() => false);
    if (found) return true;
  }
  return false;
}
