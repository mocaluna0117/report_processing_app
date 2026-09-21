/**
 * 「使い方」ページの写真を撮る。端末の Chrome を借り、架空のデータを入れた画面を切り取る。
 *
 * ★撮る先は localhost だけ（本番を撮らせない）。
 * ★撮った範囲の文字を機械で調べ、実在しうる値（社員番号の形・テナント・許可外の氏名や電話）が
 *   見つかったら**その場で中止**する。公開リポジトリに一度入れた画像は履歴から消せないため。
 * ★ブラウザが無ければ「飛ばしました」と言って終わる（既存のテストと同じ流儀）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { type Rect, hotspotPercent, unionRect } from "../../lib/help-shots-geometry";
import { HELP_SHOTS, SHOT_SCALE } from "../../lib/help-shots";
import { tryLaunch } from "../../tests/rakuraku/helpers/browser";
import { PEOPLE } from "./fixtures";
import { RECIPES, type Recipe } from "./recipes";
import { type SeedData, seedInBrowser, stubBeforeLoad } from "./seed";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const OUT_DIR = join(ROOT, "public", "help");
const REVIEW_DIR = join(ROOT, ".cache", "help-shots");
const GENERATED = join(ROOT, "lib", "help-shots.generated.ts");
const DEV_PORT = 3502;
const OWN_PORT = 3599;

export interface Options {
  /** 撮る写真を絞る（省略＝全部） */
  only: string[];
  base: string | null;
  format: "webp" | "png";
}

export function parseArgs(argv: readonly string[]): Options {
  const only: string[] = [];
  let base: string | null = null;
  let format: "webp" | "png" = "webp";
  for (const arg of argv) {
    if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (arg === "--format=png") format = "png";
    else if (arg === "--format=webp") format = "webp";
    else if (!arg.startsWith("-")) only.push(arg);
  }
  return { only, base, format };
}

/** ★localhost 以外は撮らない（本番の実データを撮る事故を形で防ぐ） */
export function assertLocal(base: string): void {
  const { hostname } = new URL(base);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(`撮れるのは手元の開発サーバーだけです: ${base}`);
  }
}

/** 開発サーバーは初回のコンパイルに時間がかかるので、気長に待つ */
const alive = async (base: string, timeoutMs = 30_000): Promise<boolean> => {
  try {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
};

/** 開発サーバー。3502 が動いていれば借り、無ければ自分で起こして最後に止める */
async function useServer(base: string | null): Promise<{ base: string; stop: () => void }> {
  if (base) {
    assertLocal(base);
    if (!(await alive(base))) throw new Error(`${base} が応答しません`);
    return { base, stop: () => {} };
  }
  // ★localhost で開く。127.0.0.1 は next.config.ts の allowedDevOrigins に無く、
  //   開発サーバーが dev のリソースを止めるので、画面が動かないまま撮れてしまう
  const running = `http://localhost:${DEV_PORT}`;
  if (await alive(running)) {
    console.log(`開発サーバー（${DEV_PORT}）を借ります`);
    return { base: running, stop: () => {} };
  }
  console.log(`開発サーバーを ${OWN_PORT} で起こします…`);
  const child = spawn("npx", ["next", "dev", "-p", String(OWN_PORT)], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, GEMINI_API_KEY: "" }, // 万一押しても外へ出さない
  });
  const own = `http://localhost:${OWN_PORT}`;
  const stop = () => child.kill();
  for (let i = 0; i < 12; i++) {
    if (await alive(own, 10_000)) return { base: own, stop };
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error("開発サーバーを起こせませんでした");
}

// ---------------------------------------------------------------------------
// 個人情報の見張り
// ---------------------------------------------------------------------------

const ALLOWED_NAMES: readonly string[] = PEOPLE.flatMap((p) => [p.name, p.kana]);
const ALLOWED_PHONES: readonly string[] = PEOPLE.map((p) => p.phone);

export function findLeaks(text: string): string[] {
  const found: string[] = [];
  const add = (label: string, value: string) => {
    const line = `${label}: ${value}`;
    if (!found.includes(line)) found.push(line);
  };
  for (const m of text.matchAll(/(?<![0-9])17[0-9]{4}(?![0-9])/g)) add("社員番号の形", m[0]);
  for (const m of text.matchAll(/rakurakuseisan\.jp/g)) add("テナントのホスト", m[0]);
  for (const m of text.matchAll(/0\d{1,3}-\d{2,4}-\d{4}/g)) {
    if (!ALLOWED_PHONES.includes(m[0])) add("許可していない電話番号", m[0]);
  }
  // 「漢字＋全角スペース＋漢字」は氏名の形。許可した架空の名前を含むもの
  // （「山田　太郎様邸」のようにファイル名へ埋まった形）以外は止める
  for (const m of text.matchAll(/[一-龥ぁ-んァ-ヶ]{1,5}　[一-龥ぁ-んァ-ヶ]{1,5}/g)) {
    if (!ALLOWED_NAMES.some((name) => m[0].includes(name))) add("氏名らしき文字列", m[0]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 撮影
// ---------------------------------------------------------------------------

const boxOf = async (page: Page, selector: string): Promise<Rect> => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`見つかりません: ${selector}`);
  return box;
};

/** PNG を、そのブラウザ自身で WebP にする（依存を増やさないため） */
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  const base64 = await page.evaluate(async (data: string) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    const buffer = await blob.arrayBuffer();
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, png.toString("base64"));
  return Buffer.from(base64, "base64");
}

interface Shot {
  id: string;
  width: number;
  height: number;
  hotspots: { x: number; y: number }[];
  text: string;
  bytes: number;
}

async function capture(browser: Browser, base: string, recipe: Recipe, format: "webp" | "png"): Promise<Shot> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: SHOT_SCALE,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    const login = recipe.login
      ? {
          sessionToken: "架空のトークン",
          expiresAt: Date.now() + 8 * 60 * 60 * 1000,
          departments: recipe.login.kind
            ? {
                [recipe.login.kind]: {
                  departments: recipe.login.departments ?? [],
                  deptCode: recipe.login.deptCode ?? null,
                },
              }
            : {},
        }
      : null;
    // ★tsx（esbuild）は関数に __name の目印を付けるので、ブラウザ側にも同じ名前を用意しておく
    //   （用意しないと page.evaluate に渡した関数が "__name is not defined" で落ちる）
    await context.addInitScript(() => {
      (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    });
    await context.addInitScript(stubBeforeLoad, login);
    const page = await context.newPage();
    // 楽楽精算へは一切つながない（部門はログインの控えに入れてあるので読みに行かないはず）
    await page.route("**/api/rakuraku/**", (route) => route.abort());
    // 開発サーバーは画面ごとに初回のコンパイルが入るので待ち時間を長めにとる
    page.setDefaultTimeout(60_000);
    await page.goto(`${base}${recipe.path}`, { waitUntil: "networkidle", timeout: 90_000 });
    if (recipe.seed) {
      await page.evaluate(seedInBrowser, recipe.seed as SeedData);
      await page.reload({ waitUntil: "networkidle", timeout: 90_000 });
    }
    // 開発サーバーの印を消す
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    // ★前回の内容の読み込みが終わるまで待つ（途中で撮ると、どのボタンも灰色の画面になる）
    await page.waitForFunction(() => !document.body.innerText.includes("前回の内容を読み込んでいます"), null, {
      timeout: 30_000,
    });
    if (recipe.hide?.length) {
      await page.addStyleTag({ content: `${recipe.hide.join(",")}{display:none!important}` });
    }
    if (recipe.act) await recipe.act(page);
    // ★操作でスクロールしていることがある。fullPage の切り取りはページ座標なので、先頭へ戻す
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);

    const clip = unionRect(
      await Promise.all(recipe.clip.map((selector) => boxOf(page, selector))),
      recipe.pad ?? 8,
      { x: 0, y: 0, width: 1280, height: await page.evaluate(() => document.body.scrollHeight) },
    );
    // ★fullPage で撮る。窓（900px）より縦に長い範囲でも切り取れるようにするため
    //   （boundingBox はページの先頭にいる前提。goto 直後なのでスクロールは 0）
    const png = await page.screenshot({ clip, animations: "disabled", type: "png", fullPage: true });
    const image = format === "webp" ? await toWebp(page, png) : png;
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${recipe.id}.${format}`), image);

    const hotspots = [] as { x: number; y: number }[];
    for (const hotspot of recipe.hotspots) {
      hotspots.push(hotspotPercent(await boxOf(page, hotspot.at), clip, hotspot));
    }
    const text = (
      await Promise.all(recipe.clip.map((selector) => page.locator(selector).first().innerText()))
    ).join("\n");
    return {
      id: recipe.id,
      width: Math.round(clip.width * SHOT_SCALE),
      height: Math.round(clip.height * SHOT_SCALE),
      hotspots,
      text,
      bytes: image.byteLength,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

function writeGenerated(shots: readonly Shot[]): void {
  const body = shots
    .map(
      (shot) =>
        `  "${shot.id}": {\n    width: ${shot.width},\n    height: ${shot.height},\n    hotspots: [${shot.hotspots
          .map((h) => `{ x: ${h.x}, y: ${h.y} }`)
          .join(", ")}],\n  },`,
    )
    .join("\n");
  writeFileSync(
    GENERATED,
    `// scripts/help-shots が書き出すファイル。手で編集しない。\n` +
      `// 撮り直すには \`npm run help:shots\`（端末の Chrome を使う）。\n` +
      `import type { HelpShotGeometry } from "@/lib/help-shots-geometry";\n\n` +
      `export const HELP_SHOT_GEOMETRY: Readonly<Record<string, HelpShotGeometry>> = {\n${body}\n};\n`,
  );
}

function writeReview(shots: readonly Shot[], format: string): void {
  mkdirSync(REVIEW_DIR, { recursive: true });
  const rows = shots
    .map(
      (shot) =>
        `<section><h2>${shot.id}（${shot.width}×${shot.height} / ${Math.round(shot.bytes / 1024)}KB）</h2>` +
        `<img src="../../public/help/${shot.id}.${format}" style="max-width:100%;border:1px solid #ccc">` +
        `<pre style="white-space:pre-wrap;font-size:12px;background:#f8fafc;padding:8px">${shot.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</pre></section>`,
    )
    .join("\n");
  writeFileSync(
    join(REVIEW_DIR, "review.html"),
    `<!doctype html><meta charset="utf-8"><title>使い方の写真の下見</title>` +
      `<body style="font-family:sans-serif;max-width:1100px;margin:auto">` +
      `<h1>撮った写真（${shots.length}枚）</h1><p>個人情報が写っていないか、ここで全部見てください。</p>${rows}`,
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const recipes = options.only.length
    ? RECIPES.filter((r) => options.only.includes(r.id))
    : RECIPES;
  if (recipes.length === 0) {
    console.error(`撮る写真がありません: ${options.only.join(", ")}`);
    return 1;
  }
  const declared = new Set(Object.values(HELP_SHOTS).flatMap((shots) => shots.map((s) => s.id)));
  for (const recipe of RECIPES) {
    if (!declared.has(recipe.id)) console.warn(`! ${recipe.id} は lib/help-shots.ts にまだ文言がありません`);
  }

  const browser = await tryLaunch();
  if (!browser) {
    console.log("Chrome / Edge が見つからないので撮影を飛ばします（いまの画像はそのままです）");
    return 0;
  }
  const server = await useServer(options.base);
  const shots: Shot[] = [];
  try {
    for (const recipe of recipes) {
      const shot = await capture(browser, server.base, recipe, options.format);
      const leaks = findLeaks(shot.text);
      if (leaks.length > 0) {
        console.error(`\n! ${recipe.id} に実在しうる値が写っています。撮影を止めます:`);
        for (const leak of leaks) console.error(`  - ${leak}`);
        return 1;
      }
      shots.push(shot);
      console.log(`${shot.id}  ${shot.width}×${shot.height}  ${Math.round(shot.bytes / 1024)}KB`);
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (options.only.length === 0) writeGenerated(shots);
  else console.log("（一部だけ撮ったので lib/help-shots.generated.ts は書き換えていません）");
  writeReview(shots, options.format);
  console.log(`\n下見: .cache/help-shots/review.html を開いて、全部の写真を目で確かめてください`);
  return 0;
}
