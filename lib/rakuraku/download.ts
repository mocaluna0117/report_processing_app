import "server-only";
import { readFile } from "node:fs/promises";
import type { BrowserContext, Download, Frame, Locator, Page } from "playwright-core";
import { type TenantConfig, assertTenantUrl } from "./config";
import { RakurakuError, sessionExpiredError } from "./errors";
import type { RakurakuKind } from "./kinds";
import type { Log } from "./list";
import { extFromContentType, extOf, fixExtension, looksLikeHtml, withExt } from "./parse/sniff";
import { escapeRegExp } from "./parse/text";

/**
 * 伝票画面の「印刷」から本体PDFを、添付欄から添付を受け取る。
 *
 * 移植元: tenmatsu.py 3482-3592（resolve_href / _http_get_to_file / ensure_extension / fetch_to_file）、
 *         4481-4600（locate_print_button / locate_attachments / fetch_body_pdf）
 *
 * ★受け取るだけ。楽楽精算のデータは変えない。受け取ったファイルは読んだらすぐ消す（Folio のサーバーに残さない）。
 */

export interface DownloadTiming {
  /** 印刷ボタンが現れるまで待つ上限。移植元 10 秒 */
  printButtonWaitMs: number;
  /** 印刷ボタンを押す操作の上限。移植元 10 秒 */
  printClickWaitMs: number;
  /** 押したあと、ダウンロード・別ウィンドウ・同じ画面のどれかで PDF が来るまで待つ上限。移植元 15 秒 */
  printPopupWaitMs: number;
  /** ダウンロードが終わるまで待つ上限。移植元 60 秒 */
  downloadTimeoutMs: number;
}

export function defaultDownloadTiming(kind: RakurakuKind): DownloadTiming {
  return {
    printButtonWaitMs: kind.detail.printButtonWaitMs,
    printClickWaitMs: kind.detail.printClickWaitMs,
    printPopupWaitMs: kind.detail.printPopupWaitMs,
    downloadTimeoutMs: 60_000,
  };
}

/** 受け取ったファイル。name は受け取ったときの名前（拡張子は中身で直してある） */
export interface FetchedFile {
  name: string;
  bytes: Uint8Array;
}

const POLL_MS = 300;
const isHttp = (url: string) => /^https?:\/\//i.test(url);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "(URLを読めません)";
  }
}

/** ログイン画面の HTML に見えるか（パスワード欄がある）。セッション切れの見分けに使う */
export function looksLikeLoginPage(bytes: Uint8Array): boolean {
  if (!looksLikeHtml(bytes)) return false;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 256 * 1024));
  return /<input[^>]*type\s*=\s*["']?password/i.test(head);
}

// ---------------------------------------------------------------------------
// ダウンロードを受け取る
// ---------------------------------------------------------------------------

/**
 * この画面と、これから開く別ウィンドウで起きたダウンロードを集める。
 * ★移植元は押した画面のダウンロードだけを待っていた。ヘッドレスの Chromium は別ウィンドウで開いた PDF を
 *   **その別ウィンドウのダウンロード**にするので、窓ごとに見張らないと取り逃がす。
 */
function watchDownloads(context: BrowserContext) {
  const found: Download[] = [];
  const onDownload = (download: Download) => found.push(download);
  const watched = new Set<Page>();
  const watch = (target: Page) => {
    if (watched.has(target)) return;
    watched.add(target);
    target.on("download", onDownload);
  };
  context.pages().forEach(watch);
  context.on("page", watch);
  let taken = 0;
  return {
    /** まだ手を付けていないダウンロードを1つ取り出す */
    next: (): Download | null => (taken < found.length ? found[taken++] : null),
    stop: async () => {
      context.off("page", watch);
      for (const target of watched) target.off("download", onDownload);
      // 使わなかったダウンロードも消す
      for (const download of found) await download.delete().catch(() => null);
    },
  };
}

/** 上限つきで待つ。時間切れなら null */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** ダウンロードを読み切って、一時ファイルはすぐ消す */
async function readDownload(download: Download, timeoutMs: number): Promise<FetchedFile> {
  try {
    const path = await within(download.path(), timeoutMs);
    if (!path) throw new Error(`${Math.round(timeoutMs / 1000)}秒待ってもダウンロードが終わりませんでした`);
    const bytes = new Uint8Array(await readFile(path));
    const suggested = download.suggestedFilename() || "download";
    return { name: fixExtension(suggested, bytes), bytes };
  } finally {
    await download.delete().catch(() => null);
  }
}

/**
 * ブラウザと同じクッキーで URL を取得する（ログインしたまま取れる）。
 * 名前は Content-Disposition → URL の末尾。拡張子が無ければ Content-Type から補う
 * （「印刷」の URL は拡張子を持たないことがあり、無いと結合するときに形式を判定できない）。
 */
async function httpGet(page: Page, url: string, timeoutMs: number): Promise<FetchedFile> {
  const response = await page.request.get(url, { timeout: timeoutMs, failOnStatusCode: false });
  try {
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const headers = response.headers();
    let name = "";
    const disposition = headers["content-disposition"] ?? "";
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
    if (star) {
      try {
        name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
      } catch {
        name = star[1].trim();
      }
    } else if (plain) {
      name = plain[1].trim();
    }
    if (!name) name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "download";
    if (!extOf(name)) name = withExt(name, extFromContentType(headers["content-type"]) ?? ".bin");
    const bytes = new Uint8Array(await response.body());
    return { name: fixExtension(name, bytes), bytes };
  } finally {
    await response.dispose().catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// 本体PDF
// ---------------------------------------------------------------------------

/**
 * 伝票画面の「印刷」ボタン。実画面では button.accesskeyPrint（表示は「print 印刷」）。
 *
 * ★**現れるまで待つ**。数えるだけ（count）はその瞬間の様子で待たないため、
 *   描画が間に合わないだけで「ボタンが見つかりません」になっていた（実機でたまに発生）。
 */
export async function locatePrintButton(frame: Frame, kind: RakurakuKind, timing: DownloadTiming): Promise<Locator> {
  const d = kind.detail;
  if (d.printButtonSelector) {
    const bySelector = frame.locator(d.printButtonSelector).first();
    const shown = await bySelector
      .waitFor({ state: "visible", timeout: timing.printButtonWaitMs })
      .then(() => true)
      .catch(() => false);
    if (shown) return bySelector;
  }
  const byText = frame.getByRole("button", { name: new RegExp(escapeRegExp(d.printButtonText)) }).first();
  // セレクタ側で待った分があるので、こちらは短めでよい
  const shown = await byText
    .waitFor({ state: "visible", timeout: d.printButtonSelector ? 3_000 : timing.printButtonWaitMs })
    .then(() => true)
    .catch(() => false);
  if (!shown) {
    throw new RakurakuError("BODY_PDF_FAILED", `「${d.printButtonText}」ボタンが見つかりません（楽楽精算の画面が変わった可能性があります）`, {
      retryable: true,
    });
  }
  return byText;
}

/**
 * 伝票画面の「印刷」から本体PDFを受け取る。
 *
 * 印刷ボタンの実装は外部の JS にあり、次の3通りがありうるので、押したあと**全部を同時に見張る**:
 *   (1) そのままダウンロードされる（別ウィンドウで開いた PDF がダウンロードになる場合も含む）
 *   (2) 別ウィンドウで PDF が開く
 *   (3) 同じ画面の中で PDF が開く
 *
 * ★押すこと自体に失敗したときは、開いた先を探しても無駄なので、そう言って止める
 *   （承認履歴のダイアログが重なっていると、ボタンは見えているのに押せない）。
 * ★別ウィンドウは about:blank で現れてから遅れて移動することがあるので、1回で判定せず見続ける。
 * ★**画面（HTML）が返ってきたら PDF として受け取らない**。途中の画面のあとで PDF が来ることがあるので
 *   待ち続け、最後まで来なければ失敗にする。ログイン画面だったらセッション切れ（SESSION_EXPIRED）。
 * ★テナントの外の URL は取りに行かない。
 * ★開いた別ウィンドウは、成功しても失敗しても閉じる。
 */
export async function fetchBodyPdf(
  page: Page,
  frame: Frame,
  kind: RakurakuKind,
  tenant: TenantConfig,
  log: Log,
  timing: DownloadTiming = defaultDownloadTiming(kind),
): Promise<FetchedFile> {
  const context = page.context();
  const pagesBefore = new Set(context.pages());
  const urlsBefore = new Set(page.frames().map((f) => f.url()));
  const button = await locatePrintButton(frame, kind, timing);
  const downloads = watchDownloads(context);
  const tried = new Set<string>();
  const rejected: string[] = [];
  let sawLoginPage = false;

  /** 受け取ったものが PDF として使えるか。画面（HTML）なら断る */
  const accept = (file: FetchedFile, where: string): FetchedFile | null => {
    if (!looksLikeHtml(file.bytes)) return file;
    if (looksLikeLoginPage(file.bytes)) sawLoginPage = true;
    rejected.push(where);
    return null;
  };

  try {
    try {
      await button.click({ timeout: timing.printClickWaitMs });
    } catch (e) {
      throw new RakurakuError(
        "BODY_PDF_FAILED",
        `「印刷」ボタンを押せませんでした（${e instanceof Error ? e.name : "Error"}）。承認履歴のダイアログが重なっている可能性があります`,
        { retryable: true },
      );
    }

    const tryUrl = async (url: string, message: string): Promise<FetchedFile | null> => {
      if (tried.has(url)) return null;
      tried.add(url);
      try {
        assertTenantUrl(url, tenant);
      } catch {
        log(`    （テナントの外の画面が開いたので取りに行きません: ${pathOf(url)}）`);
        return null;
      }
      log(message);
      try {
        return accept(await httpGet(page, url, timing.downloadTimeoutMs), `画面 ${pathOf(url)}`);
      } catch (e) {
        log(`    （取得できませんでした: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 80) : "Error"}）`);
        return null;
      }
    };

    const deadline = Date.now() + timing.printPopupWaitMs;
    for (;;) {
      // (1) ダウンロード
      for (let download = downloads.next(); download; download = downloads.next()) {
        const got = accept(await readDownload(download, timing.downloadTimeoutMs), "ダウンロード");
        if (got) return got;
      }
      // (2) 別ウィンドウ
      for (const other of context.pages()) {
        if (pagesBefore.has(other) || !isHttp(other.url())) continue;
        const got = await tryUrl(other.url(), "    （印刷が別ウィンドウで開いたのでHTTP取得します）");
        if (got) return got;
      }
      // (3) 同じ画面
      for (const f of page.frames()) {
        if (urlsBefore.has(f.url()) || !isHttp(f.url())) continue;
        const got = await tryUrl(f.url(), "    （印刷が同じ画面で開いたのでHTTP取得します）");
        if (got) return got;
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(POLL_MS);
    }

    if (sawLoginPage) throw sessionExpiredError();
    const leftovers = context
      .pages()
      .filter((p) => !pagesBefore.has(p))
      .map((p) => (isHttp(p.url()) ? pathOf(p.url()) : p.url() || "(URLなし)"));
    const where = leftovers.length > 0 ? `開いていた別ウィンドウ: ${leftovers.join(", ")}` : "別ウィンドウは開きませんでした";
    const html = rejected.length > 0 ? `。PDFではなく画面が返ってきました（${rejected.join(", ")}）` : "";
    throw new RakurakuError("BODY_PDF_FAILED", `「印刷」から本体PDFを取得できませんでした（${where}${html}）`, {
      retryable: true,
    });
  } finally {
    await downloads.stop();
    for (const other of context.pages()) {
      if (!pagesBefore.has(other)) await other.close().catch(() => null);
    }
  }
}

// ---------------------------------------------------------------------------
// 添付
// ---------------------------------------------------------------------------

export interface AttachmentItem {
  /** 画面の表示順・1始まり */
  index: number;
  /** 画面に出ている名前 */
  name: string;
  locator: Locator;
}

/**
 * 添付の一覧（表示順）。
 *
 * 実画面では `<span onclick="WorkflowDenpyo.downloadFileData(...)">` で、添付が無い枠は
 * 隠れていて中身が &nbsp;。判定は **①見えている ②&nbsp; を除いた文字が空でない** の2つだけ
 * （移植元の設定の説明には fileNo=0 とあるが、実装は見ていない。それに合わせる）。
 */
export async function locateAttachments(frame: Frame, kind: RakurakuKind): Promise<AttachmentItem[]> {
  const all = frame.locator(kind.detail.attachmentSelector);
  const count = await all.count().catch(() => 0);
  const found: AttachmentItem[] = [];
  for (let i = 0; i < count; i++) {
    const element = all.nth(i);
    const visible = await element.isVisible().catch(() => false);
    if (!visible) continue;
    const text = await element.innerText().catch(() => "");
    const name = text.replace(/\u00a0/g, "").trim();
    if (!name) continue;
    found.push({ index: found.length + 1, name, locator: element });
  }
  return found;
}

export interface AttachmentFile {
  /** 実体に合わせた拡張子（判定できなければ表示名の拡張子、それも無ければ空文字） */
  ext: string;
  bytes: Uint8Array;
}

/**
 * 添付を1つ受け取る。添付は href を持たないので、押してダウンロードを待つ。
 *
 * ★ログイン画面が返ってきたらセッション切れ（SESSION_EXPIRED）。
 * ★ほかの画面（HTML）が返ってきたら取れなかった扱いにする（表示名が .html の添付を除く）。
 *   そのまま PDF の名前で渡すと、結合の直前まで気付けない。
 */
export async function fetchAttachment(page: Page, item: AttachmentItem, timeoutMs: number): Promise<AttachmentFile> {
  const context = page.context();
  const pagesBefore = new Set(context.pages());
  const downloads = watchDownloads(context);
  try {
    await item.locator.click({ timeout: 10_000 });
    const deadline = Date.now() + timeoutMs;
    let download = downloads.next();
    while (!download && Date.now() < deadline) {
      await page.waitForTimeout(POLL_MS);
      download = downloads.next();
    }
    if (!download) throw new Error(`${Math.round(timeoutMs / 1000)}秒待ってもダウンロードが始まりませんでした`);
    const file = await readDownload(download, timeoutMs);
    if (looksLikeLoginPage(file.bytes)) throw sessionExpiredError();
    if (looksLikeHtml(file.bytes) && !/\.html?$/i.test(item.name)) {
      throw new Error("添付ではなく画面（HTML）が返ってきました");
    }
    const ext = extOf(file.name) || extOf(fixExtension(item.name, file.bytes));
    return { ext, bytes: file.bytes };
  } finally {
    await downloads.stop();
    for (const other of context.pages()) {
      if (!pagesBefore.has(other)) await other.close().catch(() => null);
    }
  }
}
