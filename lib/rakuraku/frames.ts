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
