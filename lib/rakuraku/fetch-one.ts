import "server-only";
import type { Frame, Page } from "playwright-core";
import { readFinalApprovedAt } from "./approval-log";
import type { TenantConfig } from "./config";
import type { EnsureDepartmentOptions } from "./department";
import { type DetailFields, type DetailTiming, openDetail, readDetailFields } from "./detail";
import {
  type DownloadTiming,
  defaultDownloadTiming,
  fetchAttachment,
  fetchBodyPdf,
  locateAttachments,
} from "./download";
import { fetchComposedParts } from "./compose";
import { RakurakuError } from "./errors";
import { sendFile } from "./file-frames";
import { type ListRoute, type RakurakuKind, findRoute, resolveKind } from "./kinds";
import { type ListTiming, type Log, defaultTiming, scanListForNo } from "./list";
import {
  type NavigationTiming,
  applyDepartment,
  gotoList,
  openHome,
  orderRoutes,
  pinnedRoute,
  rememberedOf,
} from "./navigation";
import { parseStaffNames } from "./parse/fields";
import { extOf } from "./parse/sniff";
import type { FetchRequest, KindId, ProgressStage, RakurakuEvent, RememberedRoute, RouteHow, RouteId } from "./protocol";

/**
 * 伝票1件を取得する（`/api/rakuraku/fetch` と `/api/rakuraku/attachment` の中身）。
 *
 * 移植元: tenmatsu.py `process_one` 4791-4945 の手順。**保存も記録もしない**（ブラウザ側が行う）。
 * 捺印決裁書の組み立て（紐づく専決決裁書を取りに行く）はまだ無い。
 */
export interface FetchRun {
  page: Page;
  tenant: TenantConfig;
  /** ログイン後に着いた画面（封じたセッションから取り出したもの） */
  home: string;
  kind: RakurakuKind;
  request: Pick<FetchRequest, "denpyoNo" | "href" | "deptCode" | "linkedNo">;
  /** 前に一覧を開けた経路（封じたセッションから取り出したもの） */
  remembered: RememberedRoute | null;
  /** 紐づく種類（捺印決裁書 → 専決決裁書）で前に一覧を開けた経路 */
  linkedRemembered?: RememberedRoute | null;
  /** 利用者が画面で固定した経路。★紐づく種類には使わない（自動で落とす） */
  pin?: RouteId | null;
  /** ログインしたときに「閲覧」タブがあったか（無ければ申請検索を先に試す） */
  viewTab?: boolean | null;
  log: Log;
  progress: (stage: ProgressStage, message: string) => void;
  /** どの経路で一覧を開いたかを知らせる（画面に出す） */
  onRoute?: (kind: KindId, route: ListRoute, how: RouteHow) => void;
  /** 行を送る（ファイルは大きいので、送り終わるのを待つ） */
  send: (event: RakurakuEvent) => Promise<void>;
  /** これを過ぎたら、残りの添付は取りに行かず TIME_BUDGET_EXCEEDED にする（関数の実行時間の上限に備える） */
  attachmentDeadlineAt?: number;
  /** 紐づく種類の設定（検証で差し替えるためのもの。本番では渡さない） */
  linkedKind?: RakurakuKind;
  /** 検証で待ち時間を縮めるためのもの。本番では渡さない */
  timing?: {
    detail?: DetailTiming;
    approvalLogWaitMs?: number;
    list?: ListTiming;
    navigation?: NavigationTiming;
    department?: EnsureDepartmentOptions;
    download?: DownloadTiming;
    /** 添付1件のダウンロードを待つ上限。移植元 60 秒 */
    attachmentTimeoutMs?: number;
    /** 添付1件ごとにあける間隔。移植元 1.5 秒 */
    requestIntervalMs?: number;
  };
}

export interface OpenedDetail {
  /** 開いている伝票画面 */
  frame: Frame;
  /** 伝票画面の URL。開き直しに使う */
  href: string;
  /** 一覧を開けた経路（一覧を開いたときだけ。次からこれを先に試す） */
  remembered: RememberedRoute | null;
  /** 伝票画面を開くのに使った経路 */
  route: ListRoute;
}

export interface DetailRecord extends OpenedDetail {
  fields: DetailFields;
}

/**
 * トップを開き、頼まれた伝票の画面を開く。
 * 伝票画面の URL が分からない伝票は、一覧を開いて行を探してから開く。
 */
export async function openRequestedDetail(run: FetchRun): Promise<OpenedDetail> {
  const { page, kind, tenant, log, progress } = run;
  const { denpyoNo } = run.request;

  progress("open", "楽楽精算を開いています");
  await openHome(page, tenant, run.home);

  let href = run.request.href;
  let remembered: RememberedRoute | null = null;
  // URL が分かっている伝票は一覧を開かないので、経路は「固定 → 前に通った経路 → アカウントに合う既定」で決める
  // （orderRoutes の先頭＝「閲覧」タブが無いアカウントなら申請検索）
  let route: ListRoute =
    (run.pin ? pinnedRoute(kind, run.pin) : findRoute(kind, run.remembered?.id)) ??
    orderRoutes(kind, { viewTab: run.viewTab })[0];
  if (!href) {
    log(`  伝票画面のURLが分からないので、${kind.label}一覧から探します`);
    progress("department", "所属部門を確かめています");
    await applyDepartment(page, run.request.deptCode, { log, reopenUrl: run.home, ...run.timing?.department });
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
    remembered = rememberedOf(location);
    route = location.route;
    const row = location.empty
      ? null
      : await scanListForNo(page, resolveKind(kind, route), denpyoNo, {
          timing: run.timing?.list ?? defaultTiming(kind),
          log,
        });
    if (!row) {
      throw new RakurakuError("DETAIL_NOT_FOUND", `伝票 ${denpyoNo} が${kind.label}の一覧に見つかりませんでした`);
    }
    href = row.href;
  }

  progress("detail", `伝票No. ${denpyoNo} を開いています`);
  const frame = await openDetail(page, resolveKind(kind, route), tenant, denpyoNo, href, {
    log,
    timing: run.timing?.detail,
  });
  // ★開き直しには、実際に開けた伝票画面の URL を使う。移植元は URL が無い伝票を
  //   もう一度「一覧のリンクを押して」開き直そうとしており、伝票画面には一覧が無いので必ず失敗していた
  return { frame, href: href ?? frame.url(), remembered, route };
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
  const opened = await openRequestedDetail(run);
  let { frame } = opened;

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
    frame = await openDetail(page, resolveKind(kind, opened.route), tenant, run.request.denpyoNo, opened.href, {
      log,
      timing: run.timing?.detail,
    });
  }
  return { ...opened, frame, fields };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "失敗しました");

/** 一覧を開けた経路（自分の種類と、捺印決裁書なら紐づく専決決裁書の分）。封じたログイン状態に覚える */
export type FetchRoutes = { routes: Partial<Record<KindId, RememberedRoute>> };

function routesOf(run: FetchRun, own: RememberedRoute | null, linked: RememberedRoute | null): FetchRoutes {
  const routes: Partial<Record<KindId, RememberedRoute>> = {};
  if (own) routes[run.kind.id] = own;
  if (linked && run.kind.compose) routes[run.kind.compose.linkedKind] = linked;
  return { routes };
}

/**
 * 伝票1件を取得する: 項目 → 本体PDF → 添付。
 *
 * 流す行: fields → file.*（本体）→ attachments → file.*（添付）/ attachment.failed …
 *
 * ★本体PDFは**2回まで**。2回目の前に伝票画面を開き直す（画面の描き直しと印刷ウィンドウの出方は毎回ぶれる）。
 *   2回とも駄目なら BODY_PDF_FAILED（retryable）。**この伝票だけの失敗**で、ブラウザは記録せずに見送る。
 * ★添付は1件取れなくても止めない（取れなかった添付は保留にして手で入れられる）。
 *   ただし**続けて2回失敗したらセッション切れとみなして止める**（1件ごとに60秒待って全部落とすより早い）。
 * ★添付1件ごとに間隔をあける（成否に関わらず）。
 */
export async function fetchOne(run: FetchRun): Promise<FetchRoutes> {
  const { page, kind, tenant, log, progress, send } = run;
  const record = await readDetailRecord(run);
  await send({ type: "fields", fields: record.fields });

  // --- 本体PDF（伝票画面の「印刷」経由）
  progress("body", "本体PDFを取得しています");
  log("  本体PDFを取得");
  const downloadTiming = run.timing?.download ?? defaultDownloadTiming(kind);
  let frame = record.frame;
  let body = null;
  for (const attempt of [1, 2]) {
    try {
      body = await fetchBodyPdf(page, frame, kind, tenant, log, downloadTiming);
      break;
    } catch (e) {
      if (e instanceof RakurakuError && e.sessionLost) throw e;
      if (attempt === 2) {
        throw new RakurakuError("BODY_PDF_FAILED", `本体PDFを取れませんでした（${errorText(e)}）`, { retryable: true });
      }
      log(`    ! 取れなかったので開き直してもう一度試します（${errorText(e)}）`);
      frame = await openDetail(page, resolveKind(kind, record.route), tenant, run.request.denpyoNo, record.href, {
        log,
        timing: run.timing?.detail,
      });
    }
  }
  if (!body) throw new RakurakuError("BODY_PDF_FAILED", "本体PDFを取れませんでした", { retryable: true });
  await sendFile(send, { role: "body", index: 0, name: "本体", ext: extOf(body.name), bytes: body.bytes });

  if (kind.compose) {
    // 捺印決裁書は自身の添付を結合しない。紐づく専決決裁書の本体と、要件に合う添付を取る
    const linked = await fetchComposedParts(run, record.fields);
    return routesOf(run, record.remembered, linked);
  }

  // --- 添付（表示順に1件ずつ。楽楽精算は一括ダウンロードができない）
  progress("attachments", "添付を取得しています");
  const attachments = await locateAttachments(frame, kind);
  await send({ type: "attachments", names: attachments.map((a) => a.name) });
  log(`  添付 ${attachments.length}件`);

  const timeoutMs = run.timing?.attachmentTimeoutMs ?? 60_000;
  const intervalMs = run.timing?.requestIntervalMs ?? 1_500;
  let misses = 0;
  for (const item of attachments) {
    if (run.attachmentDeadlineAt !== undefined && Date.now() >= run.attachmentDeadlineAt) {
      // ★黙って落とさない。残りは「時間切れ」として伝え、ブラウザが個別に取り直す
      for (const rest of attachments.filter((a) => a.index >= item.index)) {
        await send({
          type: "attachment.failed",
          index: rest.index,
          name: rest.name,
          code: "TIME_BUDGET_EXCEEDED",
          reason: "時間の上限が近いので、この添付は続けて個別に取得します",
          retryable: true,
        });
      }
      log(`  （時間の上限が近いので、${item.index}件目からの添付は個別に取得します）`);
      break;
    }
    try {
      const file = await fetchAttachment(page, item, timeoutMs);
      await sendFile(send, { role: "attachment", index: item.index, name: item.name, ext: file.ext, bytes: file.bytes });
      log(`    ${item.index}件目を取得しました（${file.ext || "拡張子なし"}）`);
      misses = 0;
    } catch (e) {
      if (e instanceof RakurakuError && e.sessionLost) throw e;
      const reason = errorText(e);
      await send({ type: "attachment.failed", index: item.index, name: item.name, code: "ATTACHMENT_FAILED", reason, retryable: true });
      log(`    ! ${item.index}件目を取得できませんでした（${reason}）`);
      misses += 1;
      if (misses >= 2) {
        throw new RakurakuError("ATTACHMENT_FAILED", "添付の取得が続けて失敗しました（ログインが切れた可能性があります）", {
          sessionLost: true,
        });
      }
    }
    if (intervalMs > 0) await page.waitForTimeout(intervalMs);
  }
  return routesOf(run, record.remembered, null);
}

/**
 * 添付を1つだけ取り直す（`/fetch` で時間切れになった添付を、あとから個別に取るため）。
 *
 * ★表示名が `/fetch` のときと違っていたら取らない（ATTACHMENT_MISMATCH）。
 *   あいだに添付が差し替わっていると、別の書類を別の枠に入れてしまうため。
 */
export async function fetchOneAttachment(
  run: FetchRun,
  index: number,
  expectedName: string,
): Promise<FetchRoutes> {
  const opened = await openRequestedDetail(run);
  run.progress("attachments", "添付を取得しています");
  const attachments = await locateAttachments(opened.frame, run.kind);
  const item = attachments.find((a) => a.index === index);
  if (!item || item.name !== expectedName) {
    throw new RakurakuError(
      "ATTACHMENT_MISMATCH",
      `伝票 ${run.request.denpyoNo} の添付が変わっています（${index}件目が見つからないか、名前が違います）。この伝票を取り直してください`,
    );
  }
  let file;
  try {
    file = await fetchAttachment(run.page, item, run.timing?.attachmentTimeoutMs ?? 60_000);
  } catch (e) {
    if (e instanceof RakurakuError) throw e;
    throw new RakurakuError("ATTACHMENT_FAILED", `添付を取得できませんでした（${errorText(e)}）`, { retryable: true });
  }
  await run.send({ type: "attachments", names: attachments.map((a) => a.name) });
  await sendFile(run.send, { role: "attachment", index: item.index, name: item.name, ext: file.ext, bytes: file.bytes });
  return routesOf(run, opened.remembered, null);
}
