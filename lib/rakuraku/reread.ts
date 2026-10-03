import "server-only";
import type { Page } from "playwright-core";
import type { TenantConfig } from "./config";
import type { EnsureDepartmentOptions } from "./department";
import { type DetailTiming, openDetail, readDetailFields } from "./detail";
import { RakurakuError } from "./errors";
import { type ListRoute, type RakurakuKind, resolveKind } from "./kinds";
import { type ListTiming, type Log, defaultTiming, findListRows } from "./list";
import { type NavigationTiming, applyDepartment, gotoList, openHome, rememberedOf } from "./navigation";
import type { KindId, ProgressStage, RakurakuEvent, RememberedRoute, RouteHow, RouteId } from "./protocol";

/**
 * 取得済みの伝票の画面を開き直して、項目だけを読む（`/api/rakuraku/reread` の中身）。
 *
 * 2026-10-03: 支出報告書の原価に使う「支払金額(税抜)」を、この項目を足す前に取得した顛末書にも埋めるため。
 *
 * 流れ: トップ → 部門 → 一覧を**1回だけ**読んで頼まれた伝票の画面の URL を集める → 1件ずつ開いて項目を読む
 * 流す行: progress / log … → detail.fields / detail.failed（伝票ごと）… → session → done
 *
 * ★楽楽精算に対しては**閲覧だけ**。本体PDF・添付・承認履歴には触らない。
 * ★期限を過ぎたら残りは開かずに終える（ブラウザは返事の無かった伝票を次の呼び出しで頼む）。
 * ★伝票画面が続けて2件開けなかったら、ログイン切れとみなして止める（1件ごとに待ち続けない）。
 */
export interface RereadRun {
  page: Page;
  tenant: TenantConfig;
  home: string;
  kind: RakurakuKind;
  denpyoNos: readonly string[];
  deptCode: string | null;
  remembered: RememberedRoute | null;
  pin?: RouteId | null;
  viewTab?: boolean | null;
  /** これを過ぎたら次の伝票を開かない */
  deadlineAt: number;
  log: Log;
  progress: (stage: ProgressStage, message: string) => void;
  onRoute?: (kind: KindId, route: ListRoute, how: RouteHow) => void;
  send: (event: RakurakuEvent) => Promise<void>;
  /** 検証で待ち時間を縮めるためのもの。本番では渡さない */
  timing?: {
    detail?: DetailTiming;
    list?: ListTiming;
    navigation?: NavigationTiming;
    department?: EnsureDepartmentOptions;
    /** 伝票1件ごとにあける間隔。取得と同じ 1.5 秒 */
    requestIntervalMs?: number;
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "失敗しました");

export async function rereadDetails(run: RereadRun): Promise<{ remembered: RememberedRoute | null }> {
  const { page, kind, tenant, log, progress, send } = run;

  progress("open", "楽楽精算を開いています");
  await openHome(page, tenant, run.home);
  progress("department", "所属部門を確かめています");
  await applyDepartment(page, run.deptCode, { log, reopenUrl: run.home, ...run.timing?.department });
  progress("navigate", `${kind.label}一覧へ移動しています`);
  const location = await gotoList(page, kind, tenant, {
    log,
    remembered: run.remembered,
    pin: run.pin,
    viewTab: run.viewTab,
    home: run.home,
    timing: run.timing?.navigation,
    onRoute: (r, how) => run.onRoute?.(kind.id, r, how),
  });
  const resolved = resolveKind(kind, location.route);

  progress("collect", `${kind.label}一覧から${run.denpyoNos.length}件を探しています`);
  const rows = location.empty
    ? new Map()
    : await findListRows(page, resolved, run.denpyoNos, {
        timing: run.timing?.list ?? defaultTiming(kind),
        log,
        deadlineAt: run.deadlineAt,
      });

  const intervalMs = run.timing?.requestIntervalMs ?? 1_500;
  let misses = 0;
  let opened = 0;
  for (const no of run.denpyoNos) {
    const row = rows.get(no);
    if (!row) {
      await send({
        type: "detail.failed",
        denpyoNo: no,
        code: "DETAIL_NOT_FOUND",
        reason: `${kind.label}の一覧に見つかりませんでした（この経路では見られない伝票かもしれません）`,
      });
      continue;
    }
    if (!row.href) {
      await send({ type: "detail.failed", denpyoNo: no, code: "DETAIL_NOT_FOUND", reason: "伝票画面の URL を一覧から読めませんでした" });
      continue;
    }
    if (Date.now() >= run.deadlineAt) {
      log("  （時間の上限が近いので、残りの伝票は次の呼び出しで読みます）");
      break;
    }
    if (opened > 0 && intervalMs > 0) await page.waitForTimeout(intervalMs);
    opened += 1;
    progress("detail", `伝票No. ${no} を開いています`);
    try {
      const frame = await openDetail(page, resolved, tenant, no, row.href, { log, timing: run.timing?.detail });
      const fields = await readDetailFields(frame, kind);
      await send({ type: "detail.fields", denpyoNo: no, fields });
      // ★値そのもの（金額・物件名）はこの行に出さない。読めたかどうかだけ
      const keys = Object.keys(kind.detail.labels);
      log(`  伝票No. ${no}: ${keys.filter((k) => fields[k]).length}/${keys.length}項目を読みました`);
      misses = 0;
    } catch (e) {
      if (e instanceof RakurakuError && e.sessionLost) throw e;
      const reason = errorText(e);
      await send({ type: "detail.failed", denpyoNo: no, code: "DETAIL_NOT_FOUND", reason });
      log(`  ! 伝票No. ${no} を開けませんでした（${reason}）`);
      misses += 1;
      if (misses >= 2) {
        throw new RakurakuError("DETAIL_NOT_FOUND", "伝票画面が続けて開けませんでした（ログインが切れた可能性があります）", {
          sessionLost: true,
        });
      }
    }
  }
  return { remembered: rememberedOf(location) };
}
