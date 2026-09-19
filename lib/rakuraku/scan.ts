import "server-only";
import type { Page } from "playwright-core";
import type { TenantConfig } from "./config";
import type { Department, EnsureDepartmentOptions } from "./department";
import { type ListRoute, type RakurakuKind, resolveKind } from "./kinds";
import { type CollectResult, type ListTiming, type Log, collectTargets, defaultTiming } from "./list";
import { type NavigationTiming, applyDepartment, gotoList, openHome, rememberedOf } from "./navigation";
import type { KindId, ProgressStage, RememberedRoute, RouteHow, RouteId, ScanRequest } from "./protocol";

/**
 * 一覧から、取得する伝票を見つける（`/api/rakuraku/scan` の中身）。
 *
 * 移植元: tenmatsu.py `run_job` 3593-3660 のうち、ログインのあと対象を集めるまで。
 * ★件数で切り詰めない。見つけた分を全部返し、何件取るか・残りが何件かはブラウザ側が決める
 *   （移植元も切り詰めは呼び出し側で行っていた）。
 * ★保存も記録もしない。Folio のサーバーには何も残らない。
 */
export interface ScanRun {
  page: Page;
  tenant: TenantConfig;
  /** ログイン後に着いた画面（封じたセッションから取り出したもの） */
  home: string;
  kind: RakurakuKind;
  request: Pick<ScanRequest, "deptCode" | "done" | "limit" | "maxPages">;
  /** 前に一覧を開けた経路（封じたセッションから取り出したもの） */
  remembered: RememberedRoute | null;
  /** 利用者が画面で固定した経路。省略すると自動で順に試す */
  pin?: RouteId | null;
  log: Log;
  progress: (stage: ProgressStage, message: string) => void;
  /** どの経路で一覧を開いたかを知らせる（画面に出す） */
  onRoute?: (kind: KindId, route: ListRoute, how: RouteHow) => void;
  /** これを過ぎたら次のページへ進まない（関数の実行時間の上限に備える） */
  deadlineAt: number;
  /** 検証で待ち時間を縮めるためのもの。本番では渡さない */
  timing?: { list?: ListTiming; navigation?: NavigationTiming; department?: EnsureDepartmentOptions };
}

export interface ScanResult {
  collect: CollectResult;
  /** 一覧を開いたときの部門。部門の切り替えが無いアカウントは null */
  department: Department | null;
  /** 一覧を開けた経路（次からこれを先に試すために覚える） */
  remembered: RememberedRoute;
  /** 一覧を開けた経路（画面に出す） */
  route: ListRoute;
}

export async function runScan(run: ScanRun): Promise<ScanResult> {
  const { page, kind, log, progress } = run;

  progress("open", "楽楽精算を開いています");
  await openHome(page, run.tenant, run.home);

  // ★部門は一覧を開く**直前に毎回**確かめる。Vercel は呼び出しごとに別のブラウザになる
  progress("department", "所属部門を確かめています");
  const department = await applyDepartment(page, run.request.deptCode, {
    log,
    reopenUrl: run.home,
    ...run.timing?.department,
  });

  log(`${kind.label}一覧へ移動します`);
  progress("navigate", `${kind.label}一覧へ移動しています`);
  const location = await gotoList(page, kind, run.tenant, {
    log,
    remembered: run.remembered,
    pin: run.pin,
    home: run.home,
    timing: run.timing?.navigation,
    onRoute: (route, how) => run.onRoute?.(kind.id, route, how),
  });
  const resolved = resolveKind(kind, location.route);

  log("対象を抽出します");
  progress("collect", "対象を抽出しています");
  const collect: CollectResult = location.empty
    ? { targets: [], scanned: 0, pages: 1, total: 0, last: 0, stoppedEarly: false, reason: null }
    : await collectTargets(page, resolved, {
        done: run.request.done,
        limit: run.request.limit,
        maxPages: run.request.maxPages,
        timing: run.timing?.list ?? defaultTiming(kind),
        log,
        deadlineAt: run.deadlineAt,
      });

  return { collect, department, remembered: rememberedOf(location), route: location.route };
}
