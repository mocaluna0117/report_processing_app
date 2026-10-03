import "server-only";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { RakurakuError } from "./errors";
import { log } from "./log";
import { SlotTimeoutError, createSlots } from "./slots";
import { CORE_DUMP_PATTERN, type SweepReport, listBrowserTemp, sweepBrowserTemp } from "./tmp-sweep";

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
  /** 起こしたときのインスタンスの様子と、こちらが閉じる前に切れたか（ログに出す数だけ） */
  diagnostics(): LaunchDiagnostics;
}

/**
 * ブラウザを起こしたときの様子。★どれも数だけ（log.ts の n_ / ms_ の形）。
 *
 * 2026-10-01、取得（scan / fetch）だけが開始から1秒以内に TARGET_CLOSED で止まり続け、
 * 同じ時間のログイン・部門の読み込みは毎回通った。Vercel は同じインスタンスを使い回すので、
 * **壊れたインスタンスに当たり続けている**のかを、起動の回数・メモリ・/tmp の空きで見分ける。
 *
 * ★interface ではなく type にする（log.ts の LogFields にそのまま渡せるように）
 */
export type LaunchDiagnostics = {
  /** このインスタンスで何回目の起動か */
  n_launch_seq: number;
  /** このインスタンス（このモジュールを読み込んでから）の経過 */
  ms_instance_up: number;
  n_free_mb?: number;
  n_total_mb?: number;
  /** この Node のプロセスが使っているメモリ */
  n_rss_mb?: number;
  n_tmp_free_mb?: number;
  /** こちらが閉じる前にブラウザが切れたとき、起動から切れるまで（切れていなければ無い） */
  ms_browser_alive?: number;
} & Partial<SweepReport>;

const INSTANCE_STARTED_AT = Date.now();
let launchCount = 0;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** インスタンスの様子を読む。★読めないものは省く（記録のために起動を止めない） */
export async function instanceSnapshot(): Promise<Omit<LaunchDiagnostics, "n_launch_seq" | "ms_browser_alive">> {
  const out: Omit<LaunchDiagnostics, "n_launch_seq" | "ms_browser_alive"> = {
    ms_instance_up: Date.now() - INSTANCE_STARTED_AT,
  };
  try {
    out.n_free_mb = mb(freemem());
    out.n_total_mb = mb(totalmem());
    out.n_rss_mb = mb(process.memoryUsage().rss);
  } catch {
    /* 省く */
  }
  try {
    const fs = await statfs(tmpdir());
    out.n_tmp_free_mb = mb(fs.bavail * fs.bsize);
  } catch {
    /* 省く */
  }
  return out;
}

const PROFILE_PREFIX = "rakuraku-";

/** このインスタンスで動いているブラウザの数と、それらが作った一時フォルダー（片付けで消さない） */
let activeBrowsers = 0;
const ownedTemp = new Set<string>();
/** 起動を1つずつ行う（起動の前後で増えた一時フォルダーを、その起動のものと決めるため） */
let launchQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = launchQueue.then(fn, fn);
  launchQueue = run.catch(() => null);
  return run;
}
/** ほかのブラウザが動いているときに消してよい古さ */
const STALE_TEMP_MS = 10 * 60 * 1000;
/** 閉じるのを待つ上限。★これを過ぎても一時フォルダーは消す（残すと /tmp が埋まる） */
const CLOSE_WAIT_MS = 15_000;
/**
 * 片付けたあとの /tmp の空きがこれより少なければ、起動しない（2026-10-03 のログで、46MB 以下では
 * 全部が起動直後に TARGET_CLOSED、それより多いときは全部動いた）。
 * ★以前はここでプロセスを終えてインスタンスを入れ替えていたが、Vercel は返事のあと止めるので
 *   終了が次の呼び出しのときに走り、その呼び出しが HTTP 500 になった。入れ替えはしない
 */
const MIN_TMP_FREE_MB = 100;

/**
 * コアダンプを書かせずに Chromium を起こすための小さな起動スクリプト（ulimit -c 0 → exec Chromium）。
 *
 * ★2026-10-03: Chromium（--single-process の headless shell）は終わるときに落ち、1回ごとに約200MB の
 *   コアダンプを /tmp に残していた。2〜3回で /tmp が埋まり、次の起動が TARGET_CLOSED で落ちていた。
 * ★/bin/sh が無い環境では作らず、Chromium をそのまま起こす（null）。
 */
export async function writeNoCoreLauncher(executablePath: string, dir: string): Promise<string | null> {
  if (!existsSync("/bin/sh")) return null;
  const path = join(dir, "chromium-nocore.sh");
  const quoted = `'${executablePath.replace(/'/g, "'\\''")}'`;
  await writeFile(path, `#!/bin/sh\nulimit -c 0\nexec ${quoted} "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

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
  // ★コアダンプを書かせない起動スクリプトを通して起こす（作れなければそのまま）
  const launcher = await writeNoCoreLauncher(executablePath, tmpdir()).catch(() => null);
  return { executablePath: launcher ?? executablePath, args: [...sparticuz.args] };
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
  launchCount += 1;
  const snapshot = { n_launch_seq: launchCount, ...(await instanceSnapshot()) };
  let launched: Omit<LaunchedBrowser, "diagnostics">;
  let sweep: SweepReport | null = null;
  /** この起動で増えた一時フォルダー（閉じるときに消す） */
  let created: string[] = [];
  try {
    launched = await oneAtATime(async () => {
      // ★前回までの起動が残した一時フォルダーを片付けてから起こす（2026-10-03 の TARGET_CLOSED の原因）
      // ★名前の形で消してよいのは Vercel の上だけ。手元の PC の一時フォルダーには、ほかのプロセス
      //   （並行して走るテスト・別の Playwright）のプロファイルもあるので、自前の古いものだけ消す
      const serverless = isServerless();
      sweep = await sweepBrowserTemp(
        tmpdir(),
        !serverless
          ? { onlyOlderThanMs: STALE_TEMP_MS, keep: ownedTemp, only: [/^rakuraku-/] }
          : activeBrowsers === 0
            ? {}
            : { onlyOlderThanMs: STALE_TEMP_MS, keep: ownedTemp },
      );
      // ★片付けても /tmp が足りなければ、起こしても必ず落ちる。起こさずに、インスタンスを入れ替える
      const freeAfter = sweep.n_tmp_free_after_mb;
      if (serverless && freeAfter !== undefined && freeAfter < MIN_TMP_FREE_MB && activeBrowsers === 0) {
        log("launch", { ...snapshot, ...sweep, ok: false, code: "TMP_FULL" });
        throw new RakurakuError(
          "BROWSER_LAUNCH_FAILED",
          "Folio のサーバーの作業場所がいっぱいで、楽楽精算を開くブラウザを起動できませんでした。少し待ってからもう一度押してください",
          { retryable: true },
        );
      }
      const before = serverless ? await listBrowserTemp(tmpdir()) : null;
      const started = await startBrowser();
      created = before ? [...(await listBrowserTemp(tmpdir()))].filter((name) => !before.has(name)) : [];
      for (const name of created) ownedTemp.add(name);
      activeBrowsers += 1;
      return started;
    });
  } catch (e) {
    release();
    // ★どの呼び元でも同じ知らせになるよう、ここで分類する
    //   （以前は部門の読み込みだけが生の英語のまま画面に出ていた）
    throw e instanceof RakurakuError ? e : browserLaunchError(e);
  }
  const launchedAt = Date.now();
  let closing = false;
  let aliveMs: number | undefined;
  launched.browser.on("disconnected", () => {
    // ★こちらが閉じたのではなく、ブラウザが自分で消えた（落ちた・強制終了された）
    if (!closing) aliveMs = Date.now() - launchedAt;
  });
  return {
    ...launched,
    close: async () => {
      closing = true;
      try {
        // ★閉じ切るのを待ちすぎない（待っている間に関数が止められると、片付けが残る）
        await Promise.race([launched.close(), sleep(CLOSE_WAIT_MS)]);
      } finally {
        // ★Playwright 任せにせず、この起動で増えた一時フォルダーを自分で消す
        for (const name of created) {
          await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => null);
          ownedTemp.delete(name);
        }
        // ★終わるときに落ちて残ったコアダンプも、その場で消す（書かせない設定が効かなかったときの備え）
        if (isServerless()) await sweepBrowserTemp(tmpdir(), { only: [CORE_DUMP_PATTERN] }).catch(() => null);
        activeBrowsers = Math.max(0, activeBrowsers - 1);
        release();
      }
    },
    diagnostics: () => ({
      ...snapshot,
      ...(sweep ?? {}),
      ...(aliveMs === undefined ? {} : { ms_browser_alive: aliveMs }),
    }),
  };
}

async function startBrowser(): Promise<Omit<LaunchedBrowser, "diagnostics">> {
  const { chromium } = await import("playwright-core");
  const profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const base = {
    headless: true,
    timeout: 45_000,
    downloadsPath: join(profileDir, "dl"),
  } as const;

  const wrap = (browser: Browser): Omit<LaunchedBrowser, "diagnostics"> => ({
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
    // ★ディスクキャッシュは自前の作業フォルダーに置き、小さくする（sparticuz の既定は 32MB で /tmp を食う）
    const cacheArgs = [
      `--disk-cache-dir=${join(profileDir, "cache")}`,
      "--disk-cache-size=1048576",
      `--crash-dumps-dir=${join(profileDir, "crash")}`,
    ];
    const launchArgs = [...args.filter((a) => !a.startsWith("--disk-cache-size=")), ...cacheArgs];
    // ★ホームと一時ファイルの置き場も作業フォルダーの中にする（閉じるときにまとめて消える）。
    //   sparticuz は HOME を /tmp にするので、そのままだと Chromium のキャッシュや設定が /tmp 直下に溜まり、
    //   起動を重ねると /tmp が埋まって Chromium が起動直後に落ちていた（2026-10-03）
    const home = join(profileDir, "home");
    const tmp = join(profileDir, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(tmp, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      TMPDIR: tmp,
    };
    return wrap(await retryOnTextFileBusy(() => chromium.launch({ ...base, executablePath, args: launchArgs, env })));
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
