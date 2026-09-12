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
