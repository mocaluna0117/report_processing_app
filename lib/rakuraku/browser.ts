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

/** 書きかけの実行ファイルを起こしてしまったときに、待ってからやり直すまで */
export const LAUNCH_RETRY_WAIT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 「実行ファイルをまだ誰かが書いている」か（ETXTBSY = text file busy）。
 * ★Vercel では Chromium を `/tmp` へ展開してから起こすので、展開の途中に起こすとこうなる。
 * ★手元でも、Chrome が自動更新している最中に同じことが起きうる。
 */
export function isTextFileBusy(error: unknown): boolean {
  return /ETXTBSY/.test(error instanceof Error ? error.message : String(error));
}

/**
 * 書きかけを掴んだときだけ、少し待って**1回だけ**やり直す。
 *
 * ★これは**ブラウザを起こす手前**のやり直しで、この時点では楽楽精算へのログインを
 *   1回も試していない。「ログインは失敗しても自動でやり直さない」（lib/rakuraku/login.ts）
 *   という決まりには触れない。
 */
export async function retryOnTextFileBusy<T>(
  run: () => Promise<T>,
  waitMs: number = LAUNCH_RETRY_WAIT_MS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isTextFileBusy(e)) throw e;
    await wait(waitMs);
    return await run();
  }
}

/**
 * 同じ処理を**このインスタンスの中で1回だけ**動かす（同時に呼ばれたら同じ結果を待つ）。
 * 失敗したときは覚えないので、次に呼ばれたらやり直せる。
 */
export function sharedOnce<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = make().catch((e) => {
        pending = null;
        throw e;
      });
    }
    return pending;
  };
}

/**
 * Vercel 用の Chromium を `/tmp` へ展開して、起こし方を返す。
 *
 * ★**展開はインスタンスごとに1回だけ**にまとめる。@sparticuz/chromium は
 *   「ファイルが在る」だけで展開済みとみなすため（`existsSync(output)`）、展開の途中に
 *   もう1つの呼び出しが来ると、**中身が空のファイルを起こして ETXTBSY** になる。
 *   部門の読み込みは一時的な失敗を1回だけやり直すので、冷えたインスタンスでこれを踏んでいた。
 */
const extractChromium = sharedOnce(async () => {
  const sparticuz = (await import("@sparticuz/chromium")).default;
  // ★args を読む前に決める（描画の設定で args が変わるため）
  sparticuz.setGraphicsMode = false;
  const executablePath = await sparticuz.executablePath();
  return { executablePath, args: [...sparticuz.args] };
});

/**
 * ブラウザを起こせなかったときの知らせ。
 * ★生の英語（`browserType.launch: spawn ETXTBSY` など）をそのまま画面に出さない。
 *   どれも**楽楽精算に触る前**の失敗なので、やり直してよい（retryable）。
 */
export function browserLaunchError(error: unknown): RakurakuError {
  const message = isTextFileBusy(error)
    ? "楽楽精算を開く準備（ブラウザの用意）が終わっていませんでした。少し待ってからもう一度お試しください"
    : `ブラウザを起動できませんでした（${error instanceof Error ? error.name : "原因不明"}）。少し待ってからもう一度お試しください`;
  return new RakurakuError("BROWSER_LAUNCH_FAILED", message, { retryable: true });
}

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
  let launched: LaunchedBrowser;
  try {
    launched = await startBrowser();
  } catch (e) {
    release();
    // ★どの呼び元でも同じ知らせになるよう、ここで分類する
    //   （以前は部門の読み込みだけが生の英語のまま画面に出ていた）
    throw e instanceof RakurakuError ? e : browserLaunchError(e);
  }
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
    const { executablePath, args } = await extractChromium();
    // ★ --user-data-dir は渡さない。playwright が自分で一時プロファイルを作って
    //   その引数を渡すので、二重に指定すると衝突する。
    //   sparticuz の args には --headless='shell' と --single-process が入っている
    //   （この Chromium は headless 専用ビルドなので外せない）。
    return wrap(await retryOnTextFileBusy(() => chromium.launch({ ...base, executablePath, args })));
  }

  const channel =
    process.env.RAKURAKU_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome");
  const headless = process.env.RAKURAKU_HEADFUL !== "1";
  try {
    return wrap(await retryOnTextFileBusy(() => chromium.launch({ ...base, channel, headless })));
  } catch (e) {
    // ★書きかけを掴んだのなら、Chrome はあるので探し直さない（自動更新の最中など）
    if (isTextFileBusy(e)) throw e;
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
