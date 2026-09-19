import "server-only";
import type { Frame, Page } from "playwright-core";
import type { TenantConfig } from "./config";
import { type EnsureDepartmentOptions, listDepartments } from "./department";
import { type DetailTiming, waitForDetailReady } from "./detail";
import { RakurakuError } from "./errors";
import { contentFrame } from "./frames";
import { KINDS, type ListRoute, type RakurakuKind, resolveKind } from "./kinds";
import type { Log } from "./list";
import {
  type NavigationTiming,
  applyDepartment,
  findMenuCandidates,
  gotoListByRoute,
  openHome,
} from "./navigation";
import { parsePagerText } from "./parse/pager";
import {
  type SurveyDetailResult,
  type SurveyElement,
  type SurveyMenuGroup,
  type SurveyProbeResult,
  type SurveyReport,
  redact,
  relativeTenantPath,
} from "./parse/survey";
import type { KindId, ProgressStage } from "./protocol";

/**
 * 「画面の下見」: 楽楽精算の**画面の作りだけ**を集めて、開発者に渡す材料にする。
 *
 * ★アカウントによって使える画面が違う（「閲覧」タブが無い人は「ワークフロー」から取る）。
 *   その人の画面はこちらからは見えないので、本人に自分のIDでログインして集めてもらう。
 * ★集めるのは**画面の作り**だけ。表は見出し行しか読まず、値の入った行・伝票の中身は読まない。
 *   URL は会社の場所を外し、問い合わせ部分も白名簿のものしか残さない（parse/survey.ts）。
 * ★押すのは `clickAllowed` に並べた文字だけ（タブの切り替え）。それ以外は**押さない**。
 *   印刷も添付の取得も行わないので、`download.ts` / `approval-log.ts` は読み込まない。
 */

/** 押してよいメニューの文字（タブの切り替えだけ。捺印決裁書の取得で普段からたどっている道筋） */
const ALLOWED_CLICKS: readonly string[] = ["ワークフロー", "押印の申請"];

export function clickAllowed(text: string): boolean {
  return ALLOWED_CLICKS.includes(text.trim());
}

/** 伝票画面で数える部品（設定が合っているかの手がかり） */
const DETAIL_SELECTORS = [
  "table.d_table_contents",
  "button.accesskeyPrint",
  "[onclick*='shoninLogKensaku']",
  'span[onclick*="downloadFileData"]',
] as const;

const MAX_ELEMENTS = 80;
const MAX_HEADERS = 20;
const MAX_LABELS = 30;

export interface SurveyProbe {
  kind: RakurakuKind;
  route: ListRoute;
}

export interface SurveyRun {
  page: Page;
  tenant: TenantConfig;
  /** ログイン後に着いた画面（封じたセッションから取り出したもの） */
  home: string;
  deptCode: string | null;
  log: Log;
  progress: (stage: ProgressStage, message: string) => void;
  /** これを過ぎたら残りの試行はやめる */
  deadlineAt: number;
  /** 試す一覧（省略すると KINDS の全部の経路） */
  probes?: SurveyProbe[];
  /** 伝票画面まで見るか。既定は未確認の経路だけ */
  detailProbes?: "unverified" | "all" | "none";
  timing?: { navigation?: NavigationTiming; detail?: DetailTiming; department?: EnsureDepartmentOptions };
}

const errorText = (e: unknown) => (e instanceof Error ? redact(e.message.split("\n")[0], 160) : "失敗しました");
const codeOf = (e: unknown) => (e instanceof RakurakuError ? e.code : "INTERNAL");

/** 画面の押せるものを集める（押さない）。★文字と場所だけ。表の値は読まない */
async function collectClickables(page: Page, tenant: TenantConfig): Promise<SurveyElement[]> {
  const out: SurveyElement[] = [];
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((): { text: string; href: string | null; onclick: string; visible: boolean; hiddenBy: string }[] => {
        const mark = (el: Element | null): string => {
          if (!el) return "";
          const id = el.id ? `#${el.id}` : "";
          const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
          return `${el.tagName.toLowerCase()}${id}${cls}`;
        };
        const hiddenBy = (el: Element): string => {
          for (let p: Element | null = el; p; p = p.parentElement) {
            if (getComputedStyle(p).display === "none") return mark(p);
          }
          return "";
        };
        const seen = new Set<string>();
        const items: { text: string; href: string | null; onclick: string; visible: boolean; hiddenBy: string }[] = [];
        for (const el of Array.from(document.querySelectorAll("a, button, [onclick], [role=tab]"))) {
          const text = ((el as HTMLElement).innerText || el.textContent || "").trim();
          const href = el.getAttribute("href");
          const onclick = el.getAttribute("onclick") || "";
          const key = `${text}|${href ?? ""}|${onclick}`;
          if (key === "||" || seen.has(key)) continue;
          seen.add(key);
          const visible = el.getClientRects().length > 0;
          items.push({
            text,
            href: href ? (el as HTMLAnchorElement).href || href : null,
            onclick,
            visible,
            hiddenBy: visible ? "" : hiddenBy(el),
          });
        }
        return items;
      })
      .catch(() => []);
    for (const item of found) {
      out.push({
        text: redact(item.text),
        path: item.href ? relativeTenantPath(item.href, tenant.loginUrl) : null,
        onclick: redact(item.onclick, 100),
        visible: item.visible,
        frame: frame.name() || "(無名)",
        ...(item.hiddenBy ? { hiddenBy: redact(item.hiddenBy, 60) } : {}),
      });
    }
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out.slice(0, MAX_ELEMENTS);
}

/** 種類ごとの「一覧」ボタンの候補を記録する（押さない） */
async function collectListCandidates(page: Page, tenant: TenantConfig): Promise<SurveyMenuGroup[]> {
  const groups: SurveyMenuGroup[] = [];
  for (const kind of Object.values(KINDS)) {
    const candidates = await findMenuCandidates(page, "一覧", kind.label).catch(() => []);
    groups.push({
      kind: kind.id,
      label: kind.label,
      candidates: candidates.slice(0, 10).map((c) => ({
        text: redact(c.text),
        path: c.href ? relativeTenantPath(new URL(c.href, tenant.loginUrl).toString(), tenant.loginUrl) : null,
        onclick: redact(c.onclick, 100),
        visible: c.visible,
        frame: c.frameName,
        nearDepth: c.nearDepth,
      })),
    });
  }
  return groups;
}

/** 一覧の見出し行（★見出しだけ。値の行は読まない）と、画面の形を数える */
async function readListShape(frame: Frame, selector: string, colNo: string, colStatus: string) {
  return await frame.evaluate(
    (a: { selector: string; colNo: string; colStatus: string }) => {
      const txt = (el: Element) => ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      const norm = (s: string) => s.replace(/[\s　.]/g, "");
      const findCol = (cells: string[], want: string) => {
        const w = norm(want);
        const exact = cells.findIndex((c) => norm(c) === w);
        if (exact >= 0) return exact;
        return cells.findIndex((c) => norm(c) !== "" && (norm(c).includes(w) || w.includes(norm(c))));
      };
      const tables = Array.from(document.querySelectorAll(a.selector)) as HTMLTableElement[];
      let headers: string[] = [];
      let rowCount = 0;
      let firstLink: string | null = null;
      for (const table of tables) {
        const rows = table.rows;
        if (!rows || rows.length < 1) continue;
        for (let r = 0; r < Math.min(rows.length, 5); r++) {
          const cells = Array.from(rows[r].cells).map(txt);
          const no = findCol(cells, a.colNo);
          const st = findCol(cells, a.colStatus);
          if (no >= 0 && st >= 0 && no !== st) {
            headers = cells;
            rowCount = Math.max(0, rows.length - (r + 1));
            const link = rows[r + 1]?.querySelector("a[href]");
            firstLink = link ? (link as HTMLAnchorElement).href : null;
            break;
          }
        }
        if (headers.length > 0) break;
      }
      const body = document.body ? document.body.innerText : "";
      return {
        hasTable: tables.length > 0,
        headers,
        rowCount,
        firstLink,
        body: body.slice(0, 4000),
        pageFeedCount: document.querySelectorAll('[onclick*="pageFeed("]').length,
      };
    },
    { selector, colNo, colStatus },
  );
}

/** 伝票画面の部品を数える（★ラベルだけ読み、値は読まない） */
async function readDetailShape(frame: Frame, selectors: readonly string[]) {
  return await frame.evaluate((list: string[]) => {
    const counts = list.map((selector) => {
      const found = Array.from(document.querySelectorAll(selector));
      return { selector, total: found.length, visible: found.filter((el) => el.getClientRects().length > 0).length };
    });
    const labels = Array.from(document.querySelectorAll("table.d_table_contents th"))
      .map((el) => ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " "))
      .filter((t) => t !== "");
    return { counts, labels };
  }, [...selectors]);
}

export async function runSurvey(run: SurveyRun): Promise<SurveyReport> {
  const { page, tenant, log, progress } = run;
  const notes: string[] = [];
  const clicked: string[] = [];
  const note = (text: string) => {
    const one = redact(text, 160);
    notes.push(one);
    log(`  ! ${one}`);
  };

  progress("open", "楽楽精算を開いています");
  await openHome(page, tenant, run.home);
  const home = await contentFrame(page);
  const report: SurveyReport = {
    at: new Date().toISOString().slice(0, 19).replace("T", " "),
    home: {
      path: relativeTenantPath(page.url(), tenant.loginUrl),
      title: redact(await home.title().catch(() => ""), 60),
      frames: page.frames().map((f) => f.name() || "(無名)"),
    },
    department: { hasSelect: false, count: 0, applied: null, message: null },
    menus: [],
    afterWorkflow: [],
    lists: [],
    clicked,
    probes: [],
    details: [],
    notes,
  };

  // --- 部門（あれば切り替えてみる。下見は失敗しても止めない）
  progress("department", "部門の作りを調べています");
  const departments = await listDepartments(page).catch(() => null);
  report.department.hasSelect = departments !== null;
  report.department.count = departments?.length ?? 0;
  if (run.deptCode !== null && departments !== null) {
    try {
      const applied = await applyDepartment(page, run.deptCode, {
        log,
        reopenUrl: run.home,
        ...run.timing?.department,
      });
      report.department.applied = applied ? redact(applied.label, 40) : null;
    } catch (e) {
      report.department.message = `部門を切り替えられませんでした（${errorText(e)}）`;
      note(report.department.message);
    }
  }

  // --- 画面に出ているメニュー（押さずに記録する）
  progress("navigate", "メニューの作りを調べています");
  log("画面に出ているメニューを調べます");
  report.menus = await collectClickables(page, tenant);

  // --- 押してよいものだけ押して、その先に「見えるようになった」ものを記録する
  //   ★隠れている要素も上で記録済みなので、ここは**見えるようになったか**で見分ける
  const before = new Set(report.menus.filter((m) => m.visible).map((m) => `${m.text}|${m.onclick}`));
  for (const text of ALLOWED_CLICKS) {
    const found = (await findMenuCandidates(page, text).catch(() => [])).filter((c) => c.visible);
    if (found.length !== 1) {
      if (found.length > 1) note(`「${text}」の候補が${found.length}個あったので押していません`);
      continue;
    }
    const pick = found[0];
    log(`  「${text}」を押して、その先に出るものを見ます`);
    const ok = await pick.frame
      .locator(`[data-tenmatsu-menu="${pick.index}"]`)
      .first()
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      note(`「${text}」を押せませんでした`);
      continue;
    }
    clicked.push(text);
    await page.waitForTimeout(1_000);
    const after = await collectClickables(page, tenant);
    for (const el of after) {
      const key = `${el.text}|${el.onclick}`;
      if (el.visible && !before.has(key)) {
        before.add(key);
        report.afterWorkflow.push(el);
      }
    }
    report.lists = await collectListCandidates(page, tenant);
  }
  if (report.lists.length === 0) report.lists = await collectListCandidates(page, tenant);

  // --- 一覧を直接開いてみる（開くだけ。行の値は読まない）
  const probes: SurveyProbe[] =
    run.probes ?? Object.values(KINDS).flatMap((kind) => kind.routes.map((route) => ({ kind, route })));
  for (const probe of probes) {
    const resolved = resolveKind(probe.kind, probe.route);
    const base: SurveyProbeResult = {
      kind: probe.kind.id,
      route: probe.route.id,
      routeLabel: probe.route.label,
      outcome: "skipped",
      message: null,
      path: null,
      title: "",
      hasListTable: false,
      headers: [],
      rowCount: 0,
      pagerPattern: null,
      pageFeedCount: 0,
      detailLinkPath: null,
      markerHits: {},
    };
    if (Date.now() >= run.deadlineAt) {
      base.message = "時間の上限が近いので試していません";
      report.probes.push(base);
      continue;
    }
    progress("navigate", `${probe.kind.label}の一覧（${probe.route.label}）を試しています`);
    log(`${probe.kind.label}の一覧を${probe.route.label}で開いてみます`);
    try {
      await openHome(page, tenant, run.home);
      const location = await gotoListByRoute(page, resolved, tenant, { log, timing: run.timing?.navigation });
      const frame = location.frame;
      base.outcome = location.empty ? "empty" : "ok";
      base.path = relativeTenantPath(frame.url(), tenant.loginUrl);
      base.title = redact(await frame.title().catch(() => ""), 60);
      const shape = await readListShape(
        frame,
        resolved.list.tableSelector,
        resolved.list.colDenpyoNo,
        resolved.list.colStatus,
      );
      base.hasListTable = shape.hasTable;
      base.headers = shape.headers.slice(0, MAX_HEADERS).map((h) => redact(h, 30));
      base.rowCount = shape.rowCount;
      base.pageFeedCount = shape.pageFeedCount;
      const pager = parsePagerText(shape.body);
      base.pagerPattern = pager ? `#件中 #件〜#件目（読めました）` : null;
      base.detailLinkPath = shape.firstLink ? relativeTenantPath(shape.firstLink, tenant.loginUrl) : null;
      for (const route of probe.kind.routes) {
        if (!route.detailUrlMarker) continue;
        base.markerHits[route.detailUrlMarker] = shape.firstLink?.includes(route.detailUrlMarker) ? 1 : 0;
      }

      // --- 伝票画面（未確認の経路だけ、先頭の1件を開いて部品を数える）
      const wantDetail =
        run.detailProbes === "all" || (run.detailProbes !== "none" && probe.route.unverified === true);
      if (wantDetail && shape.firstLink && base.outcome === "ok") {
        const detail: SurveyDetailResult = {
          kind: probe.kind.id,
          route: probe.route.id,
          path: null,
          selectors: [],
          labels: [],
          message: null,
        };
        try {
          progress("detail", `${probe.kind.label}の伝票画面の作りを調べています`);
          // ★伝票No.は渡さない（画面から拾った URL をそのまま開くだけ）
          const { openDetail } = await import("./detail");
          const detailFrame = await openDetail(page, resolved, tenant, "", shape.firstLink, {
            log,
            timing: run.timing?.detail,
          });
          const ready = await waitForDetailReady(page, detailFrame, resolved, resolved.detail.detailWaitMs);
          detail.path = relativeTenantPath(ready.url(), tenant.loginUrl);
          const found = await readDetailShape(ready, DETAIL_SELECTORS);
          detail.selectors = found.counts;
          detail.labels = found.labels.slice(0, MAX_LABELS).map((l) => redact(l, 40));
        } catch (e) {
          detail.message = `伝票画面を開けませんでした（${errorText(e)}）`;
          note(detail.message);
        }
        report.details.push(detail);
        await openHome(page, tenant, run.home);
      }
    } catch (e) {
      base.outcome = codeOf(e);
      base.message = errorText(e);
      if (e instanceof RakurakuError && (e.sessionLost || e.code === "TENANT_UNREACHABLE")) {
        report.probes.push(base);
        throw e;
      }
      note(`${probe.kind.label} / ${probe.route.label}: ${base.message}`);
    }
    report.probes.push(base);
  }

  log("下見が終わりました");
  return report;
}
