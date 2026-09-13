import "server-only";
import type { Frame, Page } from "playwright-core";
import { readFinalApprovedAt } from "./approval-log";
import type { TenantConfig } from "./config";
import type { EnsureDepartmentOptions } from "./department";
import { type DetailFields, type DetailTiming, openDetail, readDetailFields } from "./detail";
import { RakurakuError } from "./errors";
import type { RakurakuKind } from "./kinds";
import { type ListTiming, type Log, defaultTiming, scanListForNo } from "./list";
import { type NavigationTiming, applyDepartment, gotoList, openHome } from "./navigation";
import { parseStaffNames } from "./parse/fields";
import type { FetchRequest, ProgressStage } from "./protocol";

/**
 * 伝票1件を取得する（`/api/rakuraku/fetch` の中身）。
 *
 * 移植元: tenmatsu.py `process_one` 4791-4945 の手順。**保存も記録もしない**（ブラウザ側が行う）。
 * いまは「伝票を開く → 項目を読む → 承認履歴」まで。本体PDFと添付は次の段で足す。
 */
export interface FetchRun {
  page: Page;
  tenant: TenantConfig;
  /** ログイン後に着いた画面（封じたセッションから取り出したもの） */
  home: string;
  kind: RakurakuKind;
  request: Pick<FetchRequest, "denpyoNo" | "href" | "deptCode">;
  /** 前にメニューをたどって見つけた一覧の URL */
  listUrlFound: string | null;
  log: Log;
  progress: (stage: ProgressStage, message: string) => void;
  /** 検証で待ち時間を縮めるためのもの。本番では渡さない */
  timing?: {
    detail?: DetailTiming;
    approvalLogWaitMs?: number;
    list?: ListTiming;
    navigation?: NavigationTiming;
    department?: EnsureDepartmentOptions;
  };
}

export interface DetailRecord {
  fields: DetailFields;
  /** 開いている伝票画面（承認履歴を開いたときは開き直したあと） */
  frame: Frame;
  /** 伝票画面の URL。開き直しに使う */
  href: string;
  /** メニューで見つけた一覧の URL（一覧を開いたときだけ） */
  foundUrl: string | null;
}

/**
 * 伝票画面を開いて、項目と最終承認日を読む。
 *
 * ★**項目を読むのは印刷より先**。保存のあとにブラウザの操作を挟むと、そこで失敗したときに
 *   「PDFはあるのに記録が無い」状態を作れてしまう（記録漏れの実バグと同じ形）。
 * ★承認履歴を開いたら、伝票画面を開き直してから返す。ダイアログが「印刷」に重なると押せなくなる。
 *   ダイアログの「閉じる」は押さない（同じ URL への GET なので開き直しに副作用は無い）。
 */
export async function readDetailRecord(run: FetchRun): Promise<DetailRecord> {
  const { page, kind, tenant, log, progress } = run;
  const { denpyoNo } = run.request;
  const detailOptions = { log, timing: run.timing?.detail };

  progress("open", "楽楽精算を開いています");
  await openHome(page, tenant, run.home);

  let href = run.request.href;
  let foundUrl: string | null = null;
  if (!href) {
    // 一覧で伝票画面の URL が読めなかった伝票。一覧を開いて行を探し、そこから開く
    log(`  伝票画面のURLが分からないので、${kind.label}一覧から探します`);
    progress("department", "所属部門を確かめています");
    await applyDepartment(page, run.request.deptCode, { log, reopenUrl: run.home, ...run.timing?.department });
    progress("navigate", `${kind.label}一覧へ移動しています`);
    const location = await gotoList(page, kind, tenant, {
      log,
      listUrlFound: run.listUrlFound,
      timing: run.timing?.navigation,
    });
    foundUrl = location.foundUrl;
    const row = location.empty
      ? null
      : await scanListForNo(page, kind, denpyoNo, { timing: run.timing?.list ?? defaultTiming(kind), log });
    if (!row) {
      throw new RakurakuError("DETAIL_NOT_FOUND", `伝票 ${denpyoNo} が${kind.label}の一覧に見つかりませんでした`);
    }
    href = row.href;
  }

  progress("detail", `伝票No. ${denpyoNo} を開いています`);
  let frame = await openDetail(page, kind, tenant, denpyoNo, href, detailOptions);
  // ★開き直しには、実際に開けた伝票画面の URL を使う。移植元は URL が無い伝票を
  //   もう一度「一覧のリンクを押して」開き直そうとしており、伝票画面には一覧が無いので必ず失敗していた
  const detailUrl = href ?? frame.url();

  const fields = await readDetailFields(frame, kind);
  progress("approval-log", "承認履歴を読んでいます");
  const approval = await readFinalApprovedAt(page, kind, log, { waitMs: run.timing?.approvalLogWaitMs });
  if (approval.value) fields.final_approved_at = approval.value;

  // ★監督・営業の氏名はこの行に出さない（画面の記録に氏名を残さないため。値は fields で渡す）
  const staff = "where" in kind.detail.labels ? parseStaffNames(fields.where) : null;
  log(
    "  伝票画面: 申請日 " +
      (fields.shinsei_date ?? "取得できず") +
      " / 最終承認日 " +
      (approval.value ?? "取得できず") +
      ("pj" in kind.detail.labels ? ` / PJ ${fields.pj ? "取得" : "取得できず"}` : "") +
      (staff ? ` / 監督 ${staff.supervisor ? "取得" : "-"} / 営業 ${staff.sales_rep ? "取得" : "-"}` : ""),
  );

  if (approval.opened) {
    frame = await openDetail(page, kind, tenant, denpyoNo, detailUrl, detailOptions);
  }
  return { fields, frame, href: detailUrl, foundUrl };
}
