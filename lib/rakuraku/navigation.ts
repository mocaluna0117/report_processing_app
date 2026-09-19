import "server-only";
import type { Frame, Page } from "playwright-core";
import { type TenantConfig, assertTenantUrl, resolveTenantPath } from "./config";
import { type Department, type EnsureDepartmentOptions, ensureDepartment, listDepartments } from "./department";
import {
  DEPT_SELECT_MISSING_TEXT,
  RakurakuError,
  departmentNotAvailableText,
  departmentSwitchFailedText,
  listNotFoundText,
  listNotPermittedText,
  listRoutesFailedText,
  menuNotFoundText,
  routeNotAvailableText,
  sessionExpiredError,
} from "./errors";
import { contentFrame, stampDocument, waitForDetailFrame } from "./frames";
import { type ListRoute, type RakurakuKind, type ResolvedKind, findRoute, resolveKind } from "./kinds";
import type { Log } from "./list";
import { isLoginScreen } from "./login";
import { parsePagerText } from "./parse/pager";
import type { RakurakuCode, RememberedRoute, RouteHow, RouteId } from "./protocol";

/**
 * ログイン状態の確認・部門の切り替え・一覧への移動。
 *
 * 移植元: tenmatsu.py 1965-2262
 *
 * ★楽楽精算に対しては**検索・閲覧だけ**を行う。承認・申請・編集・削除につながる要素は押さない。
 */

export interface NavigationTiming {
  /** 一覧の画面（URL の目印）に着くまで待つ上限。移植元 20 秒 */
  frameWaitMs: number;
  /** フレーム内の移動が効かず、画面ごと開き直したあとに待つ上限。移植元 10 秒 */
  reopenWaitMs: number;
  /** URL が合ってから一覧の表が現れるまで待つ上限 */
  listTableWaitMs: number;
}

export const DEFAULT_NAVIGATION_TIMING: NavigationTiming = {
  frameWaitMs: 20_000,
  reopenWaitMs: 10_000,
  listTableWaitMs: 8_000,
};

const POLL_MS = 300;
const LOGIN_CHECK_MS = 1_000;

/** URL をログに出すときはパスだけにする（問い合わせ部分に伝票No.などが入る） */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(URLを読めません)";
  }
}

/**
 * ログイン画面に戻されていないかを確かめる。戻されていれば SESSION_EXPIRED。
 * ★ここで**ログインし直さない**（楽楽精算は連続して失敗するとアカウントがロックされる）。
 */
export async function assertLoggedIn(page: Page): Promise<void> {
  if (await isLoginScreen(page)) throw sessionExpiredError();
}

/**
 * 待っている間に呼ぶための、間引いたログインの確認（1秒に1回まで）。
 * ★切れていたら時間切れを待たずに SESSION_EXPIRED にする（20秒待ってから「開けません」と言わない）。
 */
export function loginWatcher(page: Page, everyMs = LOGIN_CHECK_MS): () => Promise<void> {
  let next = Date.now() + everyMs;
  return async () => {
    if (Date.now() < next) return;
    next = Date.now() + everyMs;
    await assertLoggedIn(page);
  };
}

/**
 * ログイン後に着いた画面（トップ）を開く。部門の切り替えはこの画面にある。
 * ★ログイン画面の URL を開いてはいけない。ログイン済みでもフォームが出るので、必ず「切れている」と誤判定する。
 */
export async function openHome(page: Page, tenant: TenantConfig, home: string): Promise<void> {
  const target = assertTenantUrl(home, tenant).toString();
  try {
    await page.goto(target, { waitUntil: "load", timeout: 30_000 });
  } catch (e) {
    throw new RakurakuError(
      "TENANT_UNREACHABLE",
      `楽楽精算の画面に繋がりませんでした（${e instanceof Error ? e.name : "Error"}）`,
      { retryable: true },
    );
  }
  await assertLoggedIn(page);
}

/**
 * 部門を目的のものにする。結果を必ず分けて返し、**別部門の伝票を黙って取らない**。
 *
 * - deptCode が null … 部門の切り替えが無いアカウント。プルダウンが本当に無いことを確かめてから進む
 * - それ以外 … 切り替えて、効いたことを確かめる（reopenUrl に渡したトップを開き直して読み直す）
 */
export async function applyDepartment(
  page: Page,
  deptCode: string | null,
  options: { log: Log } & EnsureDepartmentOptions,
): Promise<Department | null> {
  const { log, ...ensureOptions } = options;
  if (deptCode === null) {
    const available = await listDepartments(page);
    if (available === null) {
      log("  部門の切り替えが無いアカウントなので、そのまま一覧を開きます");
      return null;
    }
    const message =
      available.length > 0
        ? `部門を選んでから取得してください（選べるのは ${available.map((d) => d.label).join(" / ")} です）`
        : departmentNotAvailableText("部門", available);
    throw new RakurakuError("DEPT_NOT_AVAILABLE", message, { available });
  }

  const result = await ensureDepartment(page, deptCode, ensureOptions);
  switch (result.kind) {
    case "already":
      log(`  所属部門: ${result.department.label}`);
      return result.department;
    case "selected":
      log(`  所属部門を切り替えました: ${result.department.label}`);
      return result.department;
    case "not-available":
      throw new RakurakuError(
        "DEPT_NOT_AVAILABLE",
        departmentNotAvailableText(`部門コード ${deptCode}`, result.available),
        { available: result.available },
      );
    case "no-select":
      throw new RakurakuError("DEPT_SELECT_MISSING", DEPT_SELECT_MISSING_TEXT);
    case "not-applied":
      throw new RakurakuError(
        "DEPT_SWITCH_FAILED",
        departmentSwitchFailedText(result.department.label, result.current?.label ?? null),
      );
  }
}

// ---------------------------------------------------------------------------
// メニュー
// ---------------------------------------------------------------------------

export type MenuHow = "exact" | "partial";

export interface MenuCandidate {
  /** そのフレームの中で付けた番号。押すときはこの印で選ぶ */
  index: number;
  how: MenuHow;
  tag: string;
  text: string;
  href: string | null;
  onclick: string;
  /** 見えているか（隠れているタブの中のボタンを押さないため） */
  visible: boolean;
  /** near の文字を含む先祖までの段数（近いほど小さい）。無ければ null */
  nearDepth: number | null;
  frame: Frame;
  frameName: string;
}

type RawMenuCandidate = Omit<MenuCandidate, "frame" | "frameName">;

/**
 * メニューの中から、その文字に当たる要素を全フレームから集める（押さない）。
 * 移植元: tenmatsu.py 2003-2091
 *
 * 探し方は「表示文字の完全一致 → 部分一致」。前の段で1件でも取れたら次の段へ行かない。
 * ※移植元にはさらに「href/onclick に workflow を含み、文字が部分一致」の3段目があったが、
 *   2段目（文字の部分一致）の部分集合なので**決して当たらない**。写さなかった。
 *
 * ★同じリンクが上部バーとサイドメニューの両方に出ていることがある。
 *   行き先（href / onclick）と文字が同じものは1つと数える（フレームをまたいでも）。
 * ★href だけで見分けてはいけない。href="#" を共有して onclick で飛ぶ作りだと、
 *   行き先の違うメニューが1つに潰れて「複数だから止める」が効かなくなる。
 * near を渡すと、その文字を含む先祖までの段数（nearDepth）も一緒に返す。
 * 「[押印の申請] 捺印決裁書」の行にある「一覧」のように、同じ文字のボタンが
 * いくつも並ぶ画面で、目的の行のものだけを選ぶのに使う。
 */
export async function findMenuCandidates(page: Page, text: string, near?: string): Promise<MenuCandidate[]> {
  const out: MenuCandidate[] = [];
  const seen = new Set<string>();
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(
        (a: { text: string; near: string | null }): RawMenuCandidate[] => {
          const norm = (s: string | null | undefined) => (s || "").replace(/[\s\u3000]/g, "");
          const label = (el: Element) => (el as HTMLElement).innerText || el.textContent || "";
          const want = norm(a.text);
          const wantNear = a.near ? norm(a.near) : null;
          const depthToNear = (el: Element): number | null => {
            if (!wantNear) return null;
            let depth = 0;
            for (let p = el.parentElement; p && depth < 12; p = p.parentElement, depth++) {
              if (norm(label(p)).includes(wantNear)) return depth;
            }
            return null;
          };
          // 前回の印を消す（同じ画面で2回探しても番号がずれないように）
          for (const el of Array.from(document.querySelectorAll("[data-tenmatsu-menu]"))) {
            el.removeAttribute("data-tenmatsu-menu");
          }
          const seenHere = new Set<string>();
          const found: RawMenuCandidate[] = [];
          const push = (el: Element, how: "exact" | "partial") => {
            const key = [el.getAttribute("href") || "", el.getAttribute("onclick") || "", norm(label(el))].join("|");
            if (key === "||" || seenHere.has(key)) return;
            seenHere.add(key);
            // ★押すときに取り違えないよう、候補そのものに番号の印を付ける
            //   （「専決決裁書」で探すと「専決決裁書一覧」にも文字が当たるため、
            //     文字で選び直すと違う要素を押しかねない）
            el.setAttribute("data-tenmatsu-menu", String(found.length));
            found.push({
              index: found.length,
              how,
              tag: el.tagName.toLowerCase(),
              text: label(el).trim().slice(0, 60),
              href: el.getAttribute("href"),
              onclick: (el.getAttribute("onclick") || "").slice(0, 120),
              visible: el.getClientRects().length > 0,
              nearDepth: depthToNear(el),
            });
          };
          const all = Array.from(document.querySelectorAll("a, button, [onclick]"));
          for (const el of all) if (norm(label(el)) === want) push(el, "exact");
          if (found.length > 0) return found;
          for (const el of all) if (want !== "" && norm(label(el)).includes(want)) push(el, "partial");
          return found;
        },
        { text, near: near ?? null },
      )
      .catch(() => [] as RawMenuCandidate[]);
    for (const item of found) {
      const key = [item.href ?? "", item.onclick, item.text.replace(/ /g, "")].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, frame, frameName: frame.name() || "(無名)" });
    }
  }
  return out;
}

/**
 * メニューの文字を1つ押す。**1つに絞れないときは押さずに止める**。
 * 移植元: tenmatsu.py 2094-2138
 *
 * 絞り方は順に:
 *   1. near があれば、その文字を含む先祖がいちばん近いもの（同じ行の「一覧」を選ぶ）
 *   2. それでも複数なら、画面に見えているもの（隠れたタブの中を押さない）
 *   3. まだ複数なら候補を出して止める（違うメニューを押さないため）
 */
export async function clickMenuOnce(
  page: Page,
  kind: RakurakuKind,
  text: string,
  near: string | undefined,
  log: Log,
): Promise<MenuCandidate> {
  let candidates = await findMenuCandidates(page, text, near);
  const where = `「${text}」${near ? `（「${near}」の並び）` : ""}`;
  if (candidates.length === 0) {
    throw new RakurakuError("MENU_NOT_FOUND", menuNotFoundText(kind.label, where));
  }
  if (candidates.length > 1 && near) {
    const depths = candidates.map((c) => c.nearDepth).filter((d): d is number => d !== null);
    if (depths.length > 0) {
      const nearest = Math.min(...depths);
      candidates = candidates.filter((c) => c.nearDepth === nearest);
    }
  }
  if (candidates.length > 1) {
    const visible = candidates.filter((c) => c.visible);
    if (visible.length > 0) candidates = visible;
  }
  if (candidates.length > 1) {
    log(`! メニュー${where}の候補が ${candidates.length}個あります:`);
    for (const c of candidates) {
      log(`    [${c.how}] ${c.frameName} <${c.tag}> ${c.text} href=${c.href} onclick=${c.onclick}`);
    }
    throw new RakurakuError(
      "MENU_AMBIGUOUS",
      `メニュー${where}を1つに絞れませんでした（違うメニューを押さないため止めました）。楽楽精算の画面が変わった可能性があります`,
    );
  }

  const pick = candidates[0];
  log(`  メニュー${where}を押します（${pick.frameName} の <${pick.tag}> href=${pick.href}）`);
  try {
    // JS が印を付けた要素そのものを押す（文字で選び直すと取り違える）
    await pick.frame.locator(`[data-tenmatsu-menu="${pick.index}"]`).first().click({ timeout: 5_000 });
  } catch (e) {
    throw new RakurakuError(
      "MENU_NOT_FOUND",
      `メニュー${where}を押せませんでした（${e instanceof Error ? e.name : "Error"}）。楽楽精算の画面が変わった可能性があります`,
    );
  }
  return pick;
}

// ---------------------------------------------------------------------------
// 一覧へ行く
// ---------------------------------------------------------------------------

export interface ListLocation {
  frame: Frame;
  /** 一覧の画面だが、伝票が1件も無い（表そのものが描かれない） */
  empty: boolean;
  /**
   * メニューをたどって見つけた一覧の URL。次からはメニューを押さずに直接開くために覚える。
   * 直接開いたときは null
   */
  foundUrl: string | null;
  /** 実際に一覧を開けた経路。★以降の伝票画面はこの経路で開く */
  route: ListRoute;
  /** 先に試して駄目だった経路（どれも開けなかったときの文に使う） */
  tried: TriedRoute[];
}

/** 1つの経路で一覧を開いた結果（経路を決める前の形） */
export type RouteLocation = Omit<ListLocation, "route" | "tried">;

/** 開けなかった経路とその理由 */
export interface TriedRoute {
  route: ListRoute;
  code: RakurakuCode;
  message: string;
}

export interface GotoListOptions {
  log: Log;
  /** 前に一覧を開けた経路（封じたセッションから取り出したもの） */
  remembered?: RememberedRoute | null;
  /** 利用者が画面で固定した経路。★あるときは他の経路へ落とさない */
  pin?: RouteId | null;
  /** 経路を切り替える前に開き直すトップ。エラーの画面から frameset へ戻すために渡す */
  home?: string;
  timing?: NavigationTiming;
  /** 一覧を開けた経路を知らせる（画面に出す）。★開けたときだけ呼ぶ */
  onRoute?: (route: ListRoute, how: RouteHow) => void;
}

/** 1つの経路で一覧を開くときの指定 */
interface RouteGotoOptions {
  log: Log;
  /** その経路で前にメニューをたどって見つけた URL */
  listUrlFound?: string | null;
  timing?: NavigationTiming;
}

/**
 * 一覧の画面に着くまで待つ。着いたフレームを返す。着かなければ null。
 * ★待っている間にログイン画面へ戻されたら、時間切れを待たずに SESSION_EXPIRED にする。
 */
async function waitForListFrame(page: Page, marker: string, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  let nextLoginCheck = Date.now() + LOGIN_CHECK_MS;
  for (;;) {
    for (const frame of page.frames()) {
      if (frame.url().includes(marker)) {
        await frame.waitForLoadState("load", { timeout: 15_000 }).catch(() => null);
        return frame;
      }
    }
    if (Date.now() >= nextLoginCheck) {
      await assertLoggedIn(page);
      nextLoginCheck = Date.now() + LOGIN_CHECK_MS;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(POLL_MS);
  }
}

/** 一覧に伝票が1件も無いときの画面か。★実画面では未確認。確かな手がかりがあるときだけ真にする */
const EMPTY_LIST_RE = /該当する[^\n。]{0,20}(?:ありません|存在しません)/;

/**
 * 着いた画面が本当に一覧かを確かめる。
 *
 * ★**URL だけで判断しない**。移植元は URL の文字しか見ていなかったので、権限が無くて
 *   一覧の代わりにエラーの画面が出ても「着いた」とみなし、読めない理由を取り違えていた。
 *   一覧の表があることまで確かめ、無ければ LIST_NOT_PERMITTED（閲覧権限が無い可能性）を返す。
 * ※件数表示が「0件中」か「該当する…ありません」と出ているときだけは、権限ではなく
 *   **伝票が1件も無い**とみなす（表が描かれない作りに備える）。推測で空扱いにはしない。
 */
async function confirmListScreen(
  page: Page,
  frame: Frame,
  kind: ResolvedKind,
  timing: NavigationTiming,
  log: Log,
): Promise<{ frame: Frame; empty: boolean }> {
  const appeared = await frame
    .locator(kind.list.tableSelector)
    .first()
    .waitFor({ state: "attached", timeout: timing.listTableWaitMs })
    .then(() => true)
    .catch(() => false);
  if (appeared) return { frame, empty: false };

  await assertLoggedIn(page);
  const text = await frame.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
  const pager = parsePagerText(text);
  if ((pager !== null && pager[0] === 0) || EMPTY_LIST_RE.test(text)) {
    log(`  ${kind.label}の一覧に伝票がありません`);
    return { frame, empty: true };
  }
  const title = await frame.title().catch(() => "");
  log(`  ! 一覧の表が見つかりません（画面の題名: ${title || "なし"}）`);
  throw new RakurakuError("LIST_NOT_PERMITTED", listNotPermittedText(kind.label));
}

/**
 * 一覧の URL へ移動する。移植元: tenmatsu.py 2230-2262
 * frameset のためフレーム内で遷移させ、それが効かなければ画面ごと開く。
 */
async function openListUrl(
  page: Page,
  kind: ResolvedKind,
  tenant: TenantConfig,
  url: string,
  timing: NavigationTiming,
  log: Log,
): Promise<{ frame: Frame; empty: boolean }> {
  const target = assertTenantUrl(url, tenant).toString();
  const marker = kind.route.listUrlMarker;
  const onPoll = loginWatcher(page);

  const frame = await contentFrame(page);
  // ★移動の前に印を付け、印が消えた（文書が入れ替わった）ことまで確かめる。
  //   URL の一致だけで判断すると、同じ目印を持つ別の一覧（申請検索の専決決裁書と捺印決裁書）から
  //   移るときに、**移動前のフレームを「着いた」と誤判定**する
  const stamped = await stampDocument(frame);
  // 移動が始まると評価の途中で文書が捨てられて例外になることがある。移動は始まっているので無視する
  await frame
    .evaluate((u: string) => {
      window.location.href = u;
    }, target)
    .catch(() => null);
  let found = await waitForDetailFrame(page, marker, stamped, { timeoutMs: timing.frameWaitMs, onPoll });
  if (!found) {
    log("  （フレーム内での移動が効かなかったので、直接開きます）");
    try {
      await page.goto(target, { waitUntil: "load", timeout: 30_000 });
    } catch (e) {
      throw new RakurakuError(
        "TENANT_UNREACHABLE",
        `${kind.label}の一覧を開けませんでした（${e instanceof Error ? e.name : "Error"}）`,
        { retryable: true },
      );
    }
    found = await waitForListFrame(page, marker, timing.reopenWaitMs);
  }
  await assertLoggedIn(page);
  if (!found) {
    const title = await (await contentFrame(page)).title().catch(() => "");
    log(`  ! 一覧の画面になりませんでした（着いた画面: ${pathOf(page.url())}・題名: ${title || "なし"}）`);
    throw new RakurakuError("LIST_NOT_FOUND", listNotFoundText(kind.label));
  }
  return await confirmListScreen(page, found, kind, timing, log);
}

type MenuOpened = { frame: Frame } | { popupUrl: string } | null;

/**
 * メニューを押したあと、一覧が「この画面の中」か「別ウィンドウ」のどちらかに開くのを待つ。
 * ★別ウィンドウは about:blank で先に現れて遅れて移動するので、URL の目印が出るまで見続ける。
 */
async function waitForMenuResult(
  page: Page,
  marker: string,
  before: Set<Page>,
  timeoutMs: number,
): Promise<MenuOpened> {
  const deadline = Date.now() + timeoutMs;
  let nextLoginCheck = Date.now() + LOGIN_CHECK_MS;
  for (;;) {
    for (const frame of page.frames()) {
      if (frame.url().includes(marker)) {
        await frame.waitForLoadState("load", { timeout: 15_000 }).catch(() => null);
        return { frame };
      }
    }
    const opened = page.context().pages().filter((p) => !before.has(p));
    const popup = opened.find((p) => p.url().includes(marker));
    if (popup) return { popupUrl: popup.url() };
    if (Date.now() >= nextLoginCheck) {
      await assertLoggedIn(page);
      nextLoginCheck = Date.now() + LOGIN_CHECK_MS;
    }
    if (Date.now() >= deadline) {
      // 目印は出なかったが別ウィンドウは開いた。移植元と同じくその URL で開き直してみる（着いた先は確かめる）
      const other = opened.find((p) => /^https?:/.test(p.url()));
      return other ? { popupUrl: other.url() } : null;
    }
    await page.waitForTimeout(POLL_MS);
  }
}

/** メニューを押し終えたあとの共通の後始末 */
async function finishMenu(
  page: Page,
  kind: ResolvedKind,
  tenant: TenantConfig,
  before: Set<Page>,
  timing: NavigationTiming,
  log: Log,
): Promise<RouteLocation> {
  const opened = await waitForMenuResult(page, kind.route.listUrlMarker, before, timing.frameWaitMs);
  // ★開いた窓は必ず閉じる（窓を増やし続けない＆以降の処理を1つの画面で進める）
  for (const extra of page.context().pages().filter((p) => !before.has(p))) {
    await extra.close().catch(() => null);
  }

  if (opened && "popupUrl" in opened) {
    // ★一覧が別ウィンドウで開く画面もある（捺印決裁書）。URL は分かったので、元の画面で開き直す
    const url = assertTenantUrl(opened.popupUrl, tenant).toString();
    log(`  一覧のURL: ${pathOf(url)}`);
    log("  （別ウィンドウで開いたので、元の画面で開き直します）");
    const location = await openListUrl(page, kind, tenant, url, timing, log);
    return { ...location, foundUrl: url };
  }

  await assertLoggedIn(page);
  if (!opened) {
    log(`  ! メニューをたどりましたが、一覧の画面になりませんでした（着いた画面: ${pathOf(page.url())}）`);
    throw new RakurakuError("LIST_NOT_FOUND", listNotFoundText(kind.label));
  }
  log(`  一覧のURL: ${pathOf(opened.frame.url())}`);
  const location = await confirmListScreen(page, opened.frame, kind, timing, log);
  // ★2件目以降は直接移動する（これが無いと、伝票画面からメニューをたどり直すことになって失敗する）
  return { ...location, foundUrl: opened.frame.url() };
}

/**
 * メニューを何段かたどって一覧を開く（捺印決裁書: ワークフロー → 押印の申請 → 一覧）。
 * 移植元: tenmatsu.py 2141-2196
 *
 * ★段ごとに「次の段の候補が見えるようになるまで」待つ。決まった時間だけ待つ形にすると、
 *   隠れているパネルの中の要素を押しに行って空振りする（文字では当たるが押せない）。
 */
export async function gotoListBySteps(
  page: Page,
  kind: ResolvedKind,
  tenant: TenantConfig,
  options: RouteGotoOptions,
): Promise<RouteLocation> {
  const timing = options.timing ?? DEFAULT_NAVIGATION_TIMING;
  const steps = kind.route.menuSteps ?? [];
  const before = new Set(page.context().pages());

  for (let i = 0; i < steps.length; i++) {
    await clickMenuOnce(page, kind, steps[i].text, steps[i].near, options.log);
    const next = steps[i + 1];
    if (!next) break;
    const deadline = Date.now() + kind.route.menuStepWaitMs;
    for (;;) {
      const ready = (await findMenuCandidates(page, next.text, next.near)).filter((c) => c.visible);
      if (ready.length > 0 || Date.now() >= deadline) break;
      await page.waitForTimeout(POLL_MS);
    }
  }
  return await finishMenu(page, kind, tenant, before, timing, options.log);
}

/**
 * 一覧の URL が分からないとき、メニューの文字を1回押して開く。移植元: tenmatsu.py 2199-2227
 *
 * ★候補が1つに絞れないときは**押さずに止める**（違うメニューを押して別のワークフローを取りに行かないため）。
 * ※移植元は別ウィンドウで開いたら「URL を設定に書いてください」と止めていた。Folio では利用者が
 *   設定を書けないので、多段メニューと同じく URL を取って元の画面で開き直す。
 */
export async function gotoListByMenu(
  page: Page,
  kind: ResolvedKind,
  tenant: TenantConfig,
  options: RouteGotoOptions,
): Promise<RouteLocation> {
  const timing = options.timing ?? DEFAULT_NAVIGATION_TIMING;
  const before = new Set(page.context().pages());
  await clickMenuOnce(page, kind, kind.route.menuText || kind.label, undefined, options.log);
  return await finishMenu(page, kind, tenant, before, timing, options.log);
}

/**
 * 1つの経路で一覧へ移動する。移植元: tenmatsu.py 2230-2262
 *
 * 一覧のパスが分かっている経路は直接開く（メニューを手でたどる必要をなくす）。
 * 分からない経路は、前にメニューで見つけた URL → それも無ければメニューを押して開く。
 */
export async function gotoListByRoute(
  page: Page,
  kind: ResolvedKind,
  tenant: TenantConfig,
  options: RouteGotoOptions,
): Promise<RouteLocation> {
  const timing = options.timing ?? DEFAULT_NAVIGATION_TIMING;
  const url = kind.route.listPath
    ? resolveTenantPath(kind.route.listPath, tenant)
    : (options.listUrlFound ?? null);
  if (url) {
    const location = await openListUrl(page, kind, tenant, url, timing, options.log);
    return { ...location, foundUrl: null };
  }
  return kind.route.menuSteps && kind.route.menuSteps.length > 0
    ? await gotoListBySteps(page, kind, tenant, options)
    : await gotoListByMenu(page, kind, tenant, options);
}

/**
 * 画面から来た経路の指定を確かめる。
 * ★その種類に無い経路は断る（黙って自動に落とさない。利用者が固定したつもりの経路と違う伝票を取らないため）。
 */
export function pinnedRoute(kind: RakurakuKind, id: RouteId): ListRoute {
  const route = findRoute(kind, id);
  if (!route) {
    throw new RakurakuError("BAD_REQUEST", routeNotAvailableText(kind.label, kind.routes));
  }
  return route;
}

/**
 * 試す順番を決める。
 * 固定されていればそれだけ、前に使えた経路があればそれを先頭に、あとは種類の並び（閲覧 → ワークフロー）。
 */
export function orderRoutes(kind: RakurakuKind, options: Pick<GotoListOptions, "pin" | "remembered">): ListRoute[] {
  if (options.pin) return [pinnedRoute(kind, options.pin)];
  const first = findRoute(kind, options.remembered?.id);
  if (!first) return [...kind.routes];
  return [first, ...kind.routes.filter((r) => r.id !== first.id)];
}

/** 開けた経路を、封じたログイン状態に覚える形にする */
export function rememberedOf(location: ListLocation): RememberedRoute {
  return { id: location.route.id, ...(location.foundUrl ? { url: location.foundUrl } : {}) };
}

/** この失敗なら次の経路を試す。★権限や画面の違いで開けなかったときだけ */
const FALLTHROUGH_CODES: ReadonlySet<RakurakuCode> = new Set<RakurakuCode>([
  "LIST_NOT_PERMITTED",
  "LIST_NOT_FOUND",
  "MENU_NOT_FOUND",
]);

/**
 * 一覧へ移動する。経路を順に試し、開けた経路を返す。
 *
 * ★アカウントによって使える画面が違う（「閲覧」タブが無い人は「ワークフロー」から取る）ので、
 *   開けなかったら次の経路へ切り替える。どの経路で取ったかは必ず画面に出す（出る伝票の範囲が違うため）。
 * ★切り替えるのは「権限・画面の違いで開けなかった」失敗だけ。ログイン切れ・接続不可はそのまま返す。
 *   メニューを1つに絞れなかったとき（MENU_AMBIGUOUS）も切り替えない。画面が変わった疑いを
 *   別の経路の成功で隠さないため。
 */
export async function gotoList(
  page: Page,
  kind: RakurakuKind,
  tenant: TenantConfig,
  options: GotoListOptions,
): Promise<ListLocation> {
  const { log } = options;
  const order = orderRoutes(kind, options);
  const tried: TriedRoute[] = [];

  for (const [i, route] of order.entries()) {
    const how: RouteHow = options.pin
      ? "pinned"
      : options.remembered?.id === route.id
        ? "remembered"
        : i === 0
          ? "default"
          : "fallback";
    if (i > 0) {
      log(`  ! ${tried[i - 1].route.label}の一覧を開けなかったので、${route.label}へ切り替えます`);
      // エラーの画面のままだと frameset が無く次の移動が効かないので、トップへ戻る
      if (options.home) await openHome(page, tenant, options.home);
    }
    if (route.unverified) {
      log(`  （${route.label}は実画面で未確認です。開けないときは「画面の下見」の結果を開発者へ送ってください）`);
    }
    try {
      const location = await gotoListByRoute(page, resolveKind(kind, route), tenant, {
        log,
        listUrlFound: options.remembered?.id === route.id ? (options.remembered.url ?? null) : null,
        timing: options.timing,
      });
      options.onRoute?.(route, how);
      return { ...location, route, tried };
    } catch (e) {
      if (!(e instanceof RakurakuError) || !FALLTHROUGH_CODES.has(e.code)) throw e;
      tried.push({ route, code: e.code, message: e.message });
      // ★経路が1つしか無い（固定を含む）ときは、今までと同じ失敗をそのまま返す
      if (i === order.length - 1) {
        if (tried.length === 1) throw e;
        throw new RakurakuError(
          tried.some((t) => t.code === "LIST_NOT_PERMITTED") ? "LIST_NOT_PERMITTED" : e.code,
          listRoutesFailedText(kind.label, tried),
        );
      }
    }
  }
  // order は必ず1つ以上（orderRoutes が空を返さない）ので、ここには来ない
  throw new RakurakuError("LIST_NOT_FOUND", listNotFoundText(kind.label));
}
