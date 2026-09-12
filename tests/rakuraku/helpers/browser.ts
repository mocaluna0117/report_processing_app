import type { Browser } from "playwright-core";

/**
 * 手元の Chrome / Edge を借りてテストする。
 * ★ `playwright install` は走らせない（利用者のブラウザを入れ替えないため）。
 *   どれも起こせない環境ではテストを飛ばす。
 */
export async function tryLaunch(): Promise<Browser | null> {
  const { chromium } = await import("playwright-core");
  for (const channel of ["chrome", "msedge", undefined]) {
    try {
      return await chromium.launch(channel ? { channel, headless: true } : { headless: true });
    } catch {
      /* 次を試す */
    }
  }
  return null;
}
