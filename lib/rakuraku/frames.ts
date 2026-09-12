import "server-only";
import type { Frame, Page } from "playwright-core";

/**
 * 楽楽精算は `<frameset>` を使っていて、中身は name="main" のフレームの中にある。
 * そのため page ではなくフレームを相手に操作する必要がある。
 * フレームを使っていない画面（ログイン画面など）では main frame をそのまま返す。
 */
export async function contentFrame(page: Page): Promise<Frame> {
  for (const frame of page.frames()) {
    if (frame.name() === "main") return frame;
  }

  // name が違う作りに備えて、要素数が最も多いフレームを中身とみなす
  let best = page.mainFrame();
  let bestCount = -1;
  for (const frame of page.frames()) {
    const count = await frame
      .evaluate("() => document.querySelectorAll('*').length")
      .then((n) => (typeof n === "number" ? n : -1))
      .catch(() => -1);
    if (count > bestCount) {
      best = frame;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 文字列で持っている関数式（例: `"() => { DenpyoKensaku.pageFeed(2); }"`）をページで実行する。
 *
 * ★**Node 版の Playwright は、文字列で渡した関数式を呼び出さない**（関数そのものが返るだけ）。
 *   Python 版は呼び出すので、移植元の `frame.evaluate("() => ...")` をそのまま写すと
 *   **何も実行されずに黙って通過する**。ページ送りが1ページも進まない不具合として実際に踏んだ。
 *   画面の onclick から読んだ処理のように文字列でしか持てないものは、必ずここを通す。
 */
export async function evaluateFunctionString<T = unknown>(frame: Frame, fn: string): Promise<T> {
  return (await frame.evaluate(`(${fn})()`)) as T;
}

const POLL_MS = 300;
/** URL が合ったフレームの読み込み完了を待つ上限 */
const LOAD_WAIT_MS = 15_000;

type StampedWindow = { __tenmatsu_doc?: number };

/** いま開いている文書に印を付ける。付けられたら true。移植元: tenmatsu.py 1897-1907 */
export async function stampDocument(frame: Frame): Promise<boolean> {
  return await frame
    .evaluate(() => {
      (window as unknown as StampedWindow).__tenmatsu_doc = 1;
    })
    .then(() => true)
    .catch(() => false);
}

/**
 * いずれかのフレームの URL に contains が現れるまで待つ。見つかればそのフレームを返す。
 * 移植元: tenmatsu.py 1950-1962
 */
export async function waitForFrameUrl(page: Page, contains: string, timeoutMs = 20_000): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame.url().includes(contains)) {
        await frame.waitForLoadState("load", { timeout: LOAD_WAIT_MS }).catch(() => null);
        return frame;
      }
    }
    await page.waitForTimeout(POLL_MS);
  }
  return null;
}

/**
 * 伝票画面のフレームを待つ。**同じURLへ移動し直したときも待てる**。
 * 移植元: tenmatsu.py 1910-1947
 *
 * ★waitForFrameUrl との違い: URLが一致しただけでは返さず、stampDocument で
 *   付けた印が消えている（＝文書が入れ替わった）ことまで確かめる。
 *   承認履歴のあとの「開き直し」は移動前後でURLが同じなので、URLだけを見ると
 *   **移動が始まる前に古い文書を返してしまい**、そのあと印刷ボタンを探している最中に
 *   文書が差し替わって「ボタンが見つかりません」「PDFを取得できません」になる。
 * 印を付けられなかったときは今までどおりURLの一致だけで返す（悪化させない）。
 * 時間切れのときは、一致したフレームを返して呼び出し側に任せる。
 */
export async function waitForDetailFrame(
  page: Page,
  contains: string,
  stamped: boolean,
  options: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<Frame | null> {
  const swapped = async (frame: Frame): Promise<boolean> => {
    if (!stamped) return true;
    return await frame
      .evaluate(() => (window as unknown as StampedWindow).__tenmatsu_doc === undefined)
      .catch(() => false); // 移動中で評価できない＝まだ入れ替わっていない
  };

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let last: Frame | null = null;
  for (;;) {
    for (const frame of page.frames()) {
      if (!frame.url().includes(contains)) continue;
      last = frame;
      if (await swapped(frame)) {
        await frame.waitForLoadState("load", { timeout: LOAD_WAIT_MS }).catch(() => null);
        return frame;
      }
    }
    if (Date.now() >= deadline) {
      if (last) options.log?.("  （開き直しの完了を確かめられませんでした。そのまま進みます）");
      return last;
    }
    await page.waitForTimeout(POLL_MS);
  }
}
