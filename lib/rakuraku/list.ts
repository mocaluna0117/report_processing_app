import "server-only";
import type { Frame, Page } from "playwright-core";
import { contentFrame, evaluateFunctionString } from "./frames";
import type { RakurakuKind } from "./kinds";
import { isApproved } from "./parse/list";
import { normalizeDenpyoDigits } from "./parse/fields";
import {
  type NextHow,
  type Pager,
  PAGER_ACTIONS_JS,
  type PagerAction,
  parsePagerText,
  rankNextPageActions,
} from "./parse/pager";

/**
 * 一覧を読む・ページを送る・対象を集める。
 *
 * 移植元: tenmatsu.py 2568-2648, 3133-3141, 3217-3480
 */

/**
 * 進捗の1行。移植元が画面に print していたもの。
 * ★これは利用者のブラウザへ流す行で、Vercel のログ（lib/rakuraku/log.ts）とは別。
 */
export type Log = (line: string) => void;

export interface ListTiming {
  /** 続けて叩かないための間隔。移植元 request_interval_sec = 1.5 秒 */
  requestIntervalMs: number;
  /** ページ送り後に表が差し替わるまで待つ上限。★短いと「遅いだけ」を「最終ページ」と取り違える */
  nextPageWaitMs: number;
}

export function defaultTiming(kind: RakurakuKind): ListTiming {
  return { requestIntervalMs: 1_500, nextPageWaitMs: kind.list.nextPageWaitMs };
}

/** 一覧の1行。追加の列は、見つからなければ null（落とさない） */
export interface ListRow {
  denpyo_no: string;
  status: string;
  /** 伝票画面の URL（絶対）。あれば検索せずに直接開ける */
  href: string | null;
  [column: string]: string | null;
}

interface ReadArgs {
  selector: string;
  colNo: string;
  colStatus: string;
  detailMarker: string;
  extra: [key: string, header: string][];
}

/**
 * 一覧の表から 伝票No.・状態・伝票画面の URL と、指定された追加の列を読む。
 *
 * ★**列は位置ではなくヘッダーの文字で探す**。楽楽精算は一覧の表示列を会社ごとに変えられる。
 * ★ヘッダー行は先頭5行から探し、伝票No.列と状態列の**両方**が別の列として見つかった表を採る。
 * ★表示が省略された列は title 属性に全文が入っているので、**長い方を採る**。
 *   「どこで」が途中で切れると監督・営業が読めないため。
 */
export async function readTableRows(frame: Frame, kind: RakurakuKind): Promise<ListRow[]> {
  const args: ReadArgs = {
    selector: kind.list.tableSelector,
    colNo: kind.list.colDenpyoNo,
    colStatus: kind.list.colStatus,
    detailMarker: kind.list.detailUrlMarker,
    extra: Object.entries(kind.list.columns).filter(([, header]) => header.trim() !== ""),
  };
  return await frame.evaluate((a: ReadArgs) => {
    const txt = (el: Element) =>
      ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    const cellText = (el: Element) => {
      const shown = txt(el);
      const title = (el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
      return title.length > shown.length ? title : shown;
    };
    const norm = (s: string) => s.replace(/[\s\u3000.]/g, "");
    // 完全一致を優先し、見つからなければ双方向の部分一致（「伝票No.」「伝票番号」等の揺れ）
    const findCol = (cells: string[], want: string) => {
      const w = norm(want);
      const exact = cells.findIndex((c) => norm(c) === w);
      if (exact >= 0) return exact;
      return cells.findIndex((c) => norm(c) !== "" && (norm(c).includes(w) || w.includes(norm(c))));
    };
    for (const table of Array.from(document.querySelectorAll(a.selector))) {
      const rows = (table as HTMLTableElement).rows;
      if (!rows || rows.length < 2) continue;
      let headerIdx = -1;
      let iNo = -1;
      let iSt = -1;
      let headerCells: string[] = [];
      for (let r = 0; r < Math.min(rows.length, 5); r++) {
        const cells = Array.from(rows[r].cells).map(txt);
        const no = findCol(cells, a.colNo);
        const st = findCol(cells, a.colStatus);
        if (no >= 0 && st >= 0 && no !== st) {
          headerIdx = r;
          iNo = no;
          iSt = st;
          headerCells = cells;
          break;
        }
      }
      if (headerIdx < 0) continue;
      const extraIdx = a.extra.map(([key, want]) => [key, findCol(headerCells, want)] as const);
      const out: Record<string, string | null>[] = [];
      for (let r = headerIdx + 1; r < rows.length; r++) {
        const cells = Array.from(rows[r].cells);
        if (cells.length <= Math.max(iNo, iSt)) continue;
        const denpyoNo = txt(cells[iNo]);
        if (!denpyoNo) continue;
        // 伝票No.セルのリンク。無ければ行の中で伝票画面の目印を含むリンク
        const link =
          cells[iNo].querySelector("a[href]") ||
          Array.from(rows[r].querySelectorAll("a[href]")).find(
            (x) => a.detailMarker !== "" && (x.getAttribute("href") || "").includes(a.detailMarker),
          );
        const row: Record<string, string | null> = {
          denpyo_no: denpyoNo,
          status: txt(cells[iSt]),
          href: link ? (link as HTMLAnchorElement).href : null, // 絶対 URL で返る
        };
        for (const [key, i] of extraIdx) {
          row[key] = i >= 0 && i < cells.length ? cellText(cells[i]) || null : null;
        }
        out.push(row);
      }
      return out;
    }
    return [];
  }, args) as ListRow[];
}

/** 一覧の件数表示を読む。読めなければ null（落とさない） */
export async function readPager(frame: Frame): Promise<Pager | null> {
  const text = await frame
    .evaluate(() => (document.body ? document.body.innerText : ""))
    .catch(() => "");
  return parsePagerText(text);
}

async function firstRowId(frame: Frame, kind: RakurakuKind): Promise<string | null> {
  const rows = await readTableRows(frame, kind).catch(() => []);
  return rows[0]?.denpyo_no ?? null;
}

const sleep = (page: Page, ms: number) => (ms > 0 ? page.waitForTimeout(ms) : Promise.resolve());

export interface AdvanceResult {
  ok: boolean;
  how: NextHow | null;
  /** 1ページぶんではなく別のページへ飛んだ */
  jumped: boolean;
  reason: string | null;
}

/**
 * 一覧を次のページへ送り、本当に**1ページぶん進んだか**まで確かめる。
 * memo に前回うまくいった見つけ方を覚え、次からはそれを最初に試す。
 *
 * ★固定の待ち時間にしない。ページ送りは画面の読み込みではなく**表の差し替え**なので load が来ない。
 *   **先頭行の伝票No.が変わるまで**待つ。
 * ★件数表示が読めるときは、新しい先頭が「前の末尾 + 1」かを確かめ、**飛んでいたら成功扱いにしない**。
 */
export async function advancePage(
  page: Page,
  frame: Frame,
  kind: RakurakuKind,
  pager: Pager | null,
  memo: { how?: NextHow },
  timing: ListTiming,
): Promise<AdvanceResult> {
  const waitMs = timing.nextPageWaitMs;

  const waitForChange = async (before: string | null, budgetMs: number) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      await page.waitForTimeout(400);
      const after = await firstRowId(await contentFrame(page), kind);
      if (after !== null && after !== before) return true;
      if (Date.now() >= deadline) return false;
    }
  };

  const actions = ((await evaluateFunctionString<PagerAction[]>(frame, PAGER_ACTIONS_JS).catch(() => [])) ?? []);
  const candidates = rankNextPageActions(actions, pager, kind.list.nextPageJs);
  if (memo.how) {
    const first = memo.how;
    candidates.sort((x, y) => Number(x.how !== first) - Number(y.how !== first)); // 安定ソート
  }
  if (candidates.length === 0) {
    return { ok: false, how: null, jumped: false, reason: "ページ送りの要素が見つかりません" };
  }

  // 候補ごとに丸ごと待つと「どれも効かない」ときに何分もかかる。全体の持ち時間を分け合う（最低2秒）
  const perMs = Math.max(2_000, waitMs / Math.max(1, candidates.length));
  const totalDeadline = Date.now() + Math.max(waitMs, perMs);

  const tried: string[] = [];
  for (const cand of candidates) {
    if (Date.now() >= totalDeadline && tried.length > 0) {
      tried.push("時間切れ");
      break;
    }
    const before = await firstRowId(frame, kind);
    let pressed = false;
    if (cand.index !== null) {
      // 要素そのものを押す（onclick の this や付随の処理も含めて本物の動きになる）
      pressed = await frame
        .locator('[onclick*="pageFeed("]')
        .nth(cand.index)
        .click({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!pressed) {
      const failed = await evaluateFunctionString(frame, cand.js)
        .then(() => null)
        .catch((e: unknown) => (e instanceof Error ? e.name : "Error"));
      if (failed) {
        tried.push(`${cand.how}: ${failed}`);
        continue;
      }
    }
    if (!(await waitForChange(before, perMs))) {
      tried.push(`${cand.how}: 変わらず`);
      continue;
    }
    const afterPager = await readPager(await contentFrame(page));
    if (pager && afterPager) {
      const expected = pager[2] + 1;
      if (afterPager[1] !== expected) {
        return {
          ok: false,
          how: cand.how,
          jumped: true,
          reason: `ページ送りで ${afterPager[1]}件目へ飛びました（期待 ${expected}件目・見つけ方 ${cand.how}）`,
        };
      }
    }
    memo.how = cand.how;
    await sleep(page, timing.requestIntervalMs); // 続けて叩かないよう、次のページを読む前に少し置く
    return { ok: true, how: cand.how, jumped: false, reason: null };
  }

  return {
    ok: false,
    how: null,
    jumped: false,
    reason: `${waitMs}ミリ秒待っても表が変わりませんでした（試した見つけ方: ${tried.join(", ") || "なし"}）`,
  };
}

export interface Target {
  denpyoNo: string;
  href: string | null;
  /** 一覧から読んだ項目（記録に残して画面の一覧に出す） */
  meta: Record<string, string | null>;
}

export interface CollectResult {
  targets: Target[];
  /** 読んだ行数（重複を除く） */
  scanned: number;
  pages: number;
  total: number | null;
  last: number | null;
  /** ★最後のページに届く前に読むのをやめたか。「対象が0件」とは別物 */
  stoppedEarly: boolean;
  reason: string | null;
}

export interface CollectOptions {
  /** 保存済み＋保留中の伝票No.（★保留中も含める。確定するまで取り直さないため） */
  done: readonly string[];
  /** 必要数。★ページ送りを止める閾値であって、切り詰めは呼ぶ側が行う */
  limit: number;
  timing: ListTiming;
  log?: Log;
  /** これを過ぎたら次のページへ進まずに止める（関数の実行時間の上限に備える） */
  deadlineAt?: number;
}

/**
 * 処理対象を集める。一覧は申請日の降順なので、新しい未処理分は先頭ページにある。
 *
 * ★「対象が0件」と「最後まで読めていない」を**必ず区別して返す**。混ぜると、ページ送りが
 *   効かないだけなのに「新規対象はありません」と言ってしまう（実際に起きた）。
 */
export async function collectTargets(page: Page, kind: RakurakuKind, options: CollectOptions): Promise<CollectResult> {
  const log = options.log ?? (() => {});
  const doneSet = new Set(options.done);
  const targets: Target[] = [];
  const seen = new Set<string>();
  const maxPages = kind.list.maxPages;
  const metaKeys = Object.keys(kind.list.columns);
  let total: number | null = null;
  let last: number | null = null;
  let stoppedEarly = false;
  let reason: string | null = null;
  let pageNo = 0;
  let finished = false;
  const memo: { how?: NextHow } = {};

  for (pageNo = 1; pageNo <= maxPages; pageNo++) {
    const frame = await contentFrame(page);
    const rows = await readTableRows(frame, kind);
    if (rows.length === 0) {
      log("  ! 一覧の表を読めませんでした（目的の一覧が表示されていないか、列の見出しが変わった可能性があります）");
      stoppedEarly = true;
      reason = "一覧テーブルを読めませんでした";
      finished = true;
      break;
    }

    const pager = await readPager(frame);
    let first: number | null = null;
    if (pager) [total, first, last] = pager;

    let newRows = 0;
    for (const row of rows) {
      if (seen.has(row.denpyo_no)) continue; // ★重複は「読んだ行」にも数えない
      seen.add(row.denpyo_no);
      newRows++;
      if (!isApproved(row.status, kind.list.approvedValues)) continue;
      if (doneSet.has(row.denpyo_no)) continue;
      targets.push({
        denpyoNo: row.denpyo_no,
        href: row.href ?? null,
        meta: Object.fromEntries(metaKeys.map((k) => [k, row[k] ?? null])),
      });
    }
    const where = pager ? `（${total}件中 ${first}-${last}件目 / ` : "（";
    log(`  ${pageNo}ページ目: ${rows.length}行 ${where}新規 ${newRows}行 / 対象 累計${targets.length}件）`);

    if (targets.length >= options.limit) {
      finished = true;
      break;
    }
    // 件数表示から「ここが最後のページ」と分かるなら、ページ送りを試さずに終える
    if (pager && last !== null && total !== null && last >= total) {
      finished = true;
      break;
    }
    if (newRows === 0) {
      stoppedEarly = true;
      reason = "ページ送りをしても内容が変わりませんでした";
      finished = true;
      break;
    }
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      stoppedEarly = true;
      reason = "時間の上限が近いので、この先のページは次の取得で読みます";
      finished = true;
      break;
    }
    const moved = await advancePage(page, frame, kind, pager, memo, options.timing);
    if (!moved.ok) {
      stoppedEarly = true;
      reason = `${pageNo + 1}ページ目へ進めませんでした（${moved.reason}）`;
      if (moved.jumped && moved.reason) log(`  ! ${moved.reason}`);
      finished = true;
      break;
    }
  }
  if (!finished) {
    pageNo = maxPages;
    stoppedEarly = true;
    reason = `ページ数の上限（${maxPages}ページ）に達しました`;
  }

  // 件数表示が読めた場合は、そこから「最後まで見たか」を確かめ直す
  if (stoppedEarly && total !== null && last !== null && last >= total) {
    stoppedEarly = false;
    reason = null;
  }

  return { targets, scanned: seen.size, pages: pageNo, total, last, stoppedEarly, reason };
}

/**
 * いま開いている一覧を送りながら、伝票No.が一致する行を探す（捺印決裁書 → 専決決裁書）。
 *
 * ★一覧を開くのは呼ぶ側。ここは読むだけ。
 * ★伝票No.は数字だけにして比べる（`00002267` と `2267` は同じ）。
 * ★見つからなければ null。**推測で近い行を返さない**。
 */
export async function scanListForNo(
  page: Page,
  kind: RakurakuKind,
  wantNo: string,
  options: { maxPages?: number; timing: ListTiming; log?: Log },
): Promise<{ denpyoNo: string; href: string | null; status: string } | null> {
  const want = normalizeDenpyoDigits(wantNo);
  if (!want) return null;
  const limit = options.maxPages ?? kind.list.maxPages;
  const seen = new Set<string>();
  const memo: { how?: NextHow } = {};

  for (let pageNo = 1; pageNo <= limit; pageNo++) {
    const frame = await contentFrame(page);
    const rows = await readTableRows(frame, kind);
    if (rows.length === 0) return null;
    const pager = await readPager(frame);
    let newRows = 0;
    for (const row of rows) {
      if (seen.has(row.denpyo_no)) continue;
      seen.add(row.denpyo_no);
      newRows++;
      if (normalizeDenpyoDigits(row.denpyo_no) === want) {
        options.log?.(`    ${pageNo}ページ目で見つかりました: ${row.denpyo_no}（状態: ${row.status}）`);
        return { denpyoNo: row.denpyo_no, href: row.href ?? null, status: row.status };
      }
    }
    if (pager && pager[2] >= pager[0]) return null; // 最後のページまで見た
    if (newRows === 0) return null; // ページ送りが効いていない
    if (!(await advancePage(page, frame, kind, pager, memo, options.timing)).ok) return null;
  }
  return null;
}
