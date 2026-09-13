import "server-only";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { RakurakuError } from "./errors";
import { SlotTimeoutError, createSlots } from "./slots";

/**
 * 楽楽精算を操作するためのブラウザを起こす。
 *
 * ★ 開発中は端末の Chrome / Edge をそのまま使う。
 *   `playwright install msedge` は**絶対に実行しない**（利用者の Edge を入れ替えてしまう）。
 * ★ Vercel では @sparticuz/chromium を /tmp に展開して使う。
 *   Chromium のメジャー番号は playwright-core が同梱する版と必ず揃えること
 *   （ずれると起動しないか、動いても挙動が変わる）。
 */
export interface LaunchedBrowser {
  browser: Browser;
  profileDir: string;
  close(): Promise<void>;
}

const PROFILE_PREFIX = "rakuraku-";

/**
 * 同じ実行環境で同時に動かすブラウザの数と、空きを待つ上限（lib/rakuraku/slots.ts）。
 * 1日に数十件の使い方なので、重なるのはほぼ2人が同時に押したときだけ。
 */
const MAX_BROWSERS = 2;
const SLOT_WAIT_MS = 30_000;
const slots = createSlots(MAX_BROWSERS);

function isServerless(): boolean {
  return process.env.VERCEL === "1" || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

/**
 * 前回の実行が残した作業フォルダーを片付ける。
 * Vercel は同じインスタンスを使い回すので、放っておくと /tmp が埋まる。
 */
async function sweepOldProfiles(): Promise<void> {
  try {
    const base = tmpdir();
    const now = Date.now();
    for (const name of await readdir(base)) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const path = join(base, name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > 10 * 60 * 1000) {
        await rm(path, { recursive: true, force: true }).catch(() => null);
      }
    }
  } catch {
    /* 片付けに失敗しても起動は続ける */
  }
}

/**
 * ブラウザを起こす。★空きが無ければ待ち、待っても空かなければ BROWSER_BUSY（やり直してよい）。
 * 使い終わったら必ず close() する（空きを返す）。
 */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  let release: () => void;
  try {
    release = await slots.acquire(SLOT_WAIT_MS);
  } catch (e) {
    if (!(e instanceof SlotTimeoutError)) throw e;
    throw new RakurakuError("BROWSER_BUSY", "ほかの人の取得と重なって混み合っています。少し待ってからもう一度試してください", {
      retryable: true,
    });
  }
  try {
    const launched = await startBrowser();
    return {
      ...launched,
      close: async () => {
        try {
          await launched.close();
        } finally {
          release();
        }
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}

async function startBrowser(): Promise<LaunchedBrowser> {
  const { chromium } = await import("playwright-core");
  await sweepOldProfiles();
  const profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const base = {
    headless: true,
    timeout: 45_000,
    downloadsPath: join(profileDir, "dl"),
  } as const;

  const wrap = (browser: Browser): LaunchedBrowser => ({
    browser,
    profileDir,
    close: async () => {
      await browser.close().catch(() => null);
      await rm(profileDir, { recursive: true, force: true }).catch(() => null);
    },
  });

  if (isServerless()) {
    const sparticuz = (await import("@sparticuz/chromium")).default;
    sparticuz.setGraphicsMode = false;
    const executablePath = await sparticuz.executablePath();
    // ★ --user-data-dir は渡さない。playwright が自分で一時プロファイルを作って
    //   その引数を渡すので、二重に指定すると衝突する。
    //   sparticuz の args には --headless='shell' と --single-process が入っている
    //   （この Chromium は headless 専用ビルドなので外せない）。
    return wrap(await chromium.launch({ ...base, executablePath, args: [...sparticuz.args] }));
  }

  const channel =
    process.env.RAKURAKU_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome");
  const headless = process.env.RAKURAKU_HEADFUL !== "1";
  try {
    return wrap(await chromium.launch({ ...base, channel, headless }));
  } catch {
    // 端末に Chrome / Edge が無いとき（npx playwright-core install chromium 済みなら動く）
    return wrap(await chromium.launch({ ...base, headless }));
  }
}

/** 起こして、終わったら必ず片付ける */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const launched = await launchBrowser();
  try {
    return await fn(launched.browser);
  } finally {
    await launched.close();
  }
}
