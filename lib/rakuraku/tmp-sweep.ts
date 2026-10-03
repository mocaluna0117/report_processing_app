import "server-only";
import { lstat, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

/**
 * Vercel の /tmp に残ったブラウザの一時フォルダーを片付ける。
 *
 * 2026-10-03 に原因が分かった: 同じインスタンスで起動を重ねるほど /tmp の空きが減り
 * （513MB → 303MB → 13MB → 8MB）、空きが無くなると Chromium が起動して1秒以内に落ちていた（TARGET_CLOSED）。
 * 読み直し40件ほどの1回で約100MB ずつ減っていた。Playwright は一時プロファイルを
 * 「ブラウザのプロセスが終わったとき」に消すが、それが済まないまま残っていた。
 * ログアウトしても直らず、新しいインスタンスに当たったときだけ直っていたのはこのため。
 *
 * ★消すのは、ブラウザが作る一時フォルダー（下の名前の形）だけ。Chromium 本体の展開先
 *   （/tmp/chromium・al2023 など）は消さない（消すと次の起動で展開し直しになる）。
 * ★同じインスタンスでほかのブラウザが動いているときは、作ってから時間の経ったものだけ消す
 *   （動いているブラウザのプロファイルを消すと、そのブラウザが落ちる）。
 */
export const BROWSER_TEMP_PATTERNS: readonly RegExp[] = [
  /^playwright_chromiumdev_profile-/,
  /^playwright-artifacts-/,
  /^\.org\.chromium\.Chromium\./,
  /^rakuraku-/,
  // ★sparticuz は HOME を /tmp にする。Chromium がホームに書くキャッシュ・設定・証明書の置き場が
  //   /tmp 直下に溜まっていた（2026-10-03、一時フォルダー以外で 560MB）。いまは作業フォルダーの中へ向けている
  /^\.cache$/,
  /^\.config$/,
  /^\.local$/,
  /^\.pki$/,
  /^core(\.\d+)?$/,
];

/** Chromium 本体の展開先（@sparticuz/chromium）。消さない。大きさだけ別に数える */
const BIN_PATTERNS: readonly RegExp[] = [/^chromium$/, /^al2023$/, /^fonts$/, /^swiftshader/, /\.so(\.\d+)*$/, /_icd\.json$/];

export function isBrowserTemp(name: string): boolean {
  return BROWSER_TEMP_PATTERNS.some((p) => p.test(name));
}

/** その場所にある、ブラウザの一時フォルダーの名前 */
export async function listBrowserTemp(base: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(base)).filter(isBrowserTemp));
  } catch {
    return new Set();
  }
}

/** フォルダーの大きさ（バイト）。数えるのは cap 個まで（大きなフォルダーで待たせない） */
export async function sizeOf(path: string, cap = 20_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const walk = async (p: string): Promise<void> => {
    if (seen++ >= cap) return;
    const info = await lstat(p).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      const names = await readdir(p).catch(() => [] as string[]);
      for (const name of names) await walk(join(p, name));
    } else {
      total += info.size;
    }
  };
  await walk(path);
  return total;
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

export type SweepReport = {
  /** 消した一時フォルダーの数と大きさ */
  n_tmp_swept: number;
  n_tmp_swept_mb: number;
  /** Chromium 本体の展開先の大きさ（増えないはず） */
  n_tmp_bin_mb: number;
  /** どちらでもないものの大きさと数。★ここが増えていたら、まだ別に /tmp を埋めているものがある */
  n_tmp_other_mb: number;
  n_tmp_other_n: number;
  /** 片付けたあとの空き */
  n_tmp_free_after_mb?: number;
};

/**
 * 片付ける。onlyOlderThanMs を渡すと、それより前に作られたものだけ消す（ほかのブラウザが動いているとき）。
 * keep の名前は消さない。★失敗しても投げない（起動を止めない）。
 */
export async function sweepBrowserTemp(
  base: string,
  options: {
    onlyOlderThanMs?: number;
    keep?: ReadonlySet<string>;
    now?: number;
    /** 消す名前の形をしぼる（手元の PC では自前の rakuraku- だけ） */
    only?: readonly RegExp[];
  } = {},
): Promise<SweepReport> {
  const report: SweepReport = { n_tmp_swept: 0, n_tmp_swept_mb: 0, n_tmp_bin_mb: 0, n_tmp_other_mb: 0, n_tmp_other_n: 0 };
  const now = options.now ?? Date.now();
  let swept = 0;
  let other = 0;
  let bin = 0;
  let names: string[] = [];
  try {
    names = await readdir(base);
  } catch {
    return report;
  }
  for (const name of names) {
    const path = join(base, name);
    if (!isBrowserTemp(name)) {
      const size = await sizeOf(path).catch(() => 0);
      if (BIN_PATTERNS.some((p) => p.test(name))) bin += size;
      else {
        other += size;
        report.n_tmp_other_n += 1;
      }
      continue;
    }
    if (options.keep?.has(name)) continue;
    if (options.only && !options.only.some((p) => p.test(name))) continue;
    if (options.onlyOlderThanMs !== undefined) {
      const info = await lstat(path).catch(() => null);
      if (!info || now - info.mtimeMs < options.onlyOlderThanMs) continue;
    }
    const size = await sizeOf(path).catch(() => 0);
    try {
      await rm(path, { recursive: true, force: true });
      swept += size;
      report.n_tmp_swept += 1;
    } catch {
      // 消せないものは次の機会に
    }
  }
  report.n_tmp_swept_mb = mb(swept);
  report.n_tmp_other_mb = mb(other);
  report.n_tmp_bin_mb = mb(bin);
  try {
    const fs = await statfs(base);
    report.n_tmp_free_after_mb = mb(fs.bavail * fs.bsize);
  } catch {
    /* 省く */
  }
  return report;
}
