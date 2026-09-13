import "server-only";
import type { Frame, Page } from "playwright-core";
import { type TenantConfig, assertTenantUrl } from "./config";
import { RakurakuError } from "./errors";
import { contentFrame, stampDocument, waitForDetailFrame, waitForFrameUrl } from "./frames";
import type { RakurakuKind } from "./kinds";
import type { Log } from "./list";
import { assertLoggedIn, loginWatcher } from "./navigation";
import { normalizeDatetimeText } from "./parse/datetime";
import { parsePj } from "./parse/fields";
import { pickLabeledValue, pickPjNearLabel } from "./parse/tables";
import { readFrameTables } from "./tables";

/**
 * 伝票画面を開いて、項目を読む。
 *
 * 移植元: tenmatsu.py 4082-4225（wait_for_detail_ready / take_popup_url / _open_url_in_main / open_detail）、
 *         4285-4331（read_detail_fields）
 *
 * ★楽楽精算に対しては**閲覧だけ**を行う。伝票画面にある「閉じる」「取下げ」「コピー」には触れない。
 */

export interface DetailTiming {
  /** 伝票画面（URL の目印）に着くまで待つ上限。移植元 20 秒 */
  frameWaitMs: number;
  /** 画面ごと開き直したあとに待つ上限。移植元 10 秒 */
  reopenWaitMs: number;
  /** 別ウィンドウの URL が定まるまで待つ上限。移植元 8 秒 */
  popupWaitMs: number;
  /** 表が描かれるまで待つ上限。★短いと申請日が読めず「時刻が入らない」。省略すると種類の設定（8 秒） */
  readyWaitMs?: number;
}

export const DEFAULT_DETAIL_TIMING: DetailTiming = {
  frameWaitMs: 20_000,
  reopenWaitMs: 10_000,
  popupWaitMs: 8_000,
};

const POLL_MS = 300;

/**
 * 伝票画面の表が描かれるまで待って、読めるフレームを返す。
 *
 * ★URLが変わった時点では中身がまだ空のことがある。そこで読むと申請日が
 *   取れず、一覧から読んだ日付だけの値が残ってしまう（時刻が入らない原因・実バグ）。
 *   表が1つでも読めた時点で先へ進むので、速い画面では待たない。
 * 待っても読めなければ元のフレームを返す（読めない理由は呼び出し側が扱う）。
 */
export async function waitForDetailReady(
  page: Page,
  frame: Frame,
  kind: RakurakuKind,
  timeoutMs = kind.detail.detailWaitMs,
): Promise<Frame> {
  const narrow = kind.detail.tableSelector || "table";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of [frame, await contentFrame(page)]) {
      for (const selector of [narrow, "table"]) {
        if ((await readFrameTables(candidate, selector)).length > 0) return candidate;
      }
    }
    if (Date.now() >= deadline) return frame;
    await page.waitForTimeout(POLL_MS);
  }
}

/**
 * 別ウィンドウが開いていたら URL を取り、その窓を閉じる。開いていなければ null。
 *
 * ★窓は必ず閉じる。開いたままだと窓が増え続け、以降の処理（印刷の別ウィンドウ判定など）も混乱する。
 *   URL さえ分かれば、元の画面で開き直せる。
 * about:blank で現れてから遅れて移動する作りもあるので、URL が定まるまで少し待つ。
 * ※移植元は時間切れのとき窓を閉じずに返していた。ここでは時間切れでも閉じる。
 */
export async function takePopupUrl(
  page: Page,
  pagesBefore: ReadonlySet<Page>,
  marker: string,
  timeoutMs = DEFAULT_DETAIL_TIMING.popupWaitMs,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const closeAll = async (opened: Page[]) => {
    for (const extra of opened) await extra.close().catch(() => null);
  };
  for (;;) {
    const opened = page.context().pages().filter((p) => !pagesBefore.has(p));
    for (const candidate of opened) {
      const url = candidate.url();
      if (url.includes(marker) || /^https?:\/\//.test(url)) {
        await closeAll(opened);
        return url;
      }
    }
    if (opened.length === 0) return null;
    if (Date.now() >= deadline) {
      await closeAll(opened);
      return null;
    }
    await page.waitForTimeout(POLL_MS);
  }
}

/** URL を「いま見ている画面」で開く（frameset の中 → だめなら画面ごと） */
async function openUrlInMain(
  page: Page,
  url: string,
  kind: RakurakuKind,
  timing: DetailTiming,
  log: Log,
): Promise<Frame | null> {
  const marker = kind.list.detailUrlMarker;
  const onPoll = loginWatcher(page);
  const frame = await contentFrame(page);
  const stamped = await stampDocument(frame);
  await frame
    .evaluate((u: string) => {
      window.location.href = u;
    }, url)
    .catch(() => null);
  const found = await waitForDetailFrame(page, marker, stamped, { timeoutMs: timing.frameWaitMs, log, onPoll });
  if (found) return await waitForDetailReady(page, found, kind, timing.readyWaitMs);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  } catch {
    return null;
  }
  const again = await waitForFrameUrl(page, marker, timing.reopenWaitMs, onPoll);
  return again ? await waitForDetailReady(page, again, kind, timing.readyWaitMs) : null;
}

/** CSS の属性セレクタに文字列を安全に埋め込む */
function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r\f]/g, " ")}"`;
}

export interface OpenDetailOptions {
  log: Log;
  timing?: DetailTiming;
}

/**
 * 伝票の画面を開く。開けた伝票画面のフレームを返す。
 *
 * 一覧の伝票No.リンクは通常の GET リンクなので、その URL へ直接移動する（検索欄を使わない）。
 * URL が無いときは、いま開いている一覧のリンクを押す。
 *
 * ★移動を投げる前に印を付ける。すでに伝票画面にいるとき（承認履歴のあとの開き直し）は
 *   URL が変わらないので、印が消えたかどうかで移動の完了を見分ける。
 * ★画面によっては伝票が**別ウィンドウで開く**（捺印決裁書の申請一覧）。
 *   そのときは URL だけ受け取って窓を閉じ、元の画面で開き直す（以降の印刷・添付を1つの画面で進めるため）。
 * ★ログイン画面に戻されたら、待ち切らずに SESSION_EXPIRED にする。
 */
export async function openDetail(
  page: Page,
  kind: RakurakuKind,
  tenant: TenantConfig,
  denpyoNo: string,
  href: string | null,
  options: OpenDetailOptions,
): Promise<Frame> {
  const { log } = options;
  const timing = options.timing ?? DEFAULT_DETAIL_TIMING;
  const marker = kind.list.detailUrlMarker;
  const onPoll = loginWatcher(page);
  const pagesBefore = new Set(page.context().pages());

  if (href) {
    const target = assertTenantUrl(href, tenant).toString();
    const frame = await contentFrame(page);
    const stamped = await stampDocument(frame);
    // 移動が始まると評価の途中で文書が捨てられて例外になることがある。移動は始まっているので無視する
    await frame
      .evaluate((u: string) => {
        window.location.href = u;
      }, target)
      .catch(() => null);
    const found = await waitForDetailFrame(page, marker, stamped, { timeoutMs: timing.frameWaitMs, log, onPoll });
    if (found) return await waitForDetailReady(page, found, kind, timing.readyWaitMs);

    const popped = await takePopupUrl(page, pagesBefore, marker, timing.popupWaitMs);
    if (popped) {
      log("  （伝票画面が別ウィンドウで開いたので、元の画面で開き直します）");
      const got = await openUrlInMain(page, assertTenantUrl(popped, tenant).toString(), kind, timing, log);
      if (got) return got;
    }
    await assertLoggedIn(page);
    log("  （URL直接移動が効かなかったので、リンクをクリックします）");
  }

  const frame = await contentFrame(page);
  // 伝票No.の文字がリンクになっている画面（顛末書・専決決裁書）
  let link = frame.getByRole("link", { name: denpyoNo, exact: false });
  if ((await link.count()) === 0 && href) {
    // ★伝票No.が文字リンクでない画面もある。一覧から読んだ href の要素を直接押す
    const tail = href.split("/").pop() ?? href;
    link = frame.locator(`a[href=${cssString(href)}], a[href$=${cssString(tail)}]`);
  }
  if ((await link.count()) === 0) {
    await assertLoggedIn(page);
    // URL へ移動したあとは一覧から離れているので、リンクが無いのは当然。理由を取り違えさせない
    const why = href ? "伝票画面にたどり着けません" : "一覧にリンクが見つかりません";
    throw new RakurakuError(
      "DETAIL_NOT_FOUND",
      `伝票 ${denpyoNo} を開けませんでした（${why}）。楽楽精算の画面が変わった可能性があります`,
    );
  }
  await link.first().click({ timeout: 10_000 });
  await page.waitForLoadState("load").catch(() => null);
  const found = await waitForFrameUrl(page, marker, timing.frameWaitMs, onPoll);
  if (found) return await waitForDetailReady(page, found, kind, timing.readyWaitMs);

  // ※移植元はここで別ウィンドウのフレームをそのまま返していた（窓が開いたまま残る）。
  //   別ウィンドウは必ず URL だけ取って閉じ、元の画面で開き直す
  const popped = await takePopupUrl(page, pagesBefore, marker, timing.popupWaitMs);
  if (popped) {
    log("  （伝票画面が別ウィンドウで開いたので、元の画面で開き直します）");
    const got = await openUrlInMain(page, assertTenantUrl(popped, tenant).toString(), kind, timing, log);
    if (got) return got;
  }
  await assertLoggedIn(page);
  throw new RakurakuError(
    "DETAIL_NOT_FOUND",
    `伝票 ${denpyoNo} の画面を開けませんでした（伝票画面にたどり着けません）。楽楽精算の画面が変わった可能性があります`,
  );
}

/** 伝票画面から読んだ項目（記録のキー → 値）。★読めなかった項目はキーごと入れない */
export type DetailFields = Record<string, string>;

/**
 * 伝票画面の「ラベル→値」の表から項目を読む（クリックはしない）。
 *
 * 一覧の申請日は日付だけ（2026/09/01）だが、伝票画面には秒まで出る（2026/09/04 17:51:38）のでそちらを採る。
 * ★ラベルが見つからなければ値を入れずに返す。**取れなかった項目で一覧から読めた値を消してはいけない**
 *   ので、使う側は値があるときだけ上書きする。
 */
export async function readDetailFields(frame: Frame, kind: RakurakuKind): Promise<DetailFields> {
  const fields: DetailFields = {};
  const narrow = kind.detail.tableSelector || "table";
  let tables = await readFrameTables(frame, narrow);
  if (narrow !== "table") {
    // 指定した表に無いことがあるので、画面の全部の表も後ろに足して見る
    tables = [...tables, ...(await readFrameTables(frame, "table"))];
  }

  const labels = Object.fromEntries(Object.entries(kind.detail.labels).filter(([, label]) => label.trim() !== ""));
  for (const [key, label] of Object.entries(labels)) {
    if (key === "pj") continue; // 「どこで」と一緒に下で扱う（位置で探す経路があるため）
    let got = pickLabeledValue(tables, label);
    if (key === "shinsei_date") got = normalizeDatetimeText(got);
    if (got) fields[key] = got;
  }

  // 「どこで」は一覧にもあるが、表示が途中で切れることがある。監督・営業はこの文字列から読むので、
  // 伝票画面の全文を優先する。PJコードは「どこで」のすぐ下の行にあるので、ここで一緒に探す。
  // ★条件は「設定に『どこで』があるか」。**値が読めたか**にしてはいけない
  //   （「どこで」が空でもPJの行は読める伝票があり、そこでPJを取り逃がすと永久に埋まらない）
  if ("where" in labels) {
    const pjLabel = labels.pj ?? "";
    let pj = pjLabel ? parsePj(pickLabeledValue(tables, pjLabel)) : null;
    if (!pj) [pj] = pickPjNearLabel(tables, labels.where);
    if (pj) fields.pj = pj;
  }
  return fields;
}
