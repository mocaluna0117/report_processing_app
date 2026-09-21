import "server-only";
import { openDetail, readDetailFields } from "./detail";
import { defaultDownloadTiming, fetchAttachment, fetchBodyPdf, locateAttachments } from "./download";
import { RakurakuError } from "./errors";
import { sendFile } from "./file-frames";
import type { FetchRun } from "./fetch-one";
import { KINDS, type RakurakuKind, resolveKind } from "./kinds";
import { defaultTiming, scanListForNo } from "./list";
import { applyDepartment, gotoList, openHome, rememberedOf } from "./navigation";
import { normalizeDenpyoDigits } from "./parse/fields";
import type { RememberedRoute } from "./protocol";
import { composeNatsuinParts, natsuinFinalName } from "./parse/natsuin";
import { extOf } from "./parse/sniff";

/**
 * 捺印決裁書に紐づく専決決裁書から、本体と要件に合う添付を取る（組み立ての材料を流す）。
 *
 * 移植元: tenmatsu.py 4617-4790（_fetch_linked_body / _process_composed の取得の部分）
 * 並べる・結合する・保留にするのはブラウザ側（lib/tenmatsu/local/job.ts）。
 *
 * ★紐づけに失敗した4通りを**別々の理由として**返す: 番号が読めない／一覧を開けない／見つからない／本体が取れない。
 *   最初の3つでは添付の選別もしない。4つ目（本体が取れない）でも添付は取れるだけ取る。
 * ★支払先・決裁申請額は捺印決裁書の画面に無いので、専決決裁書の画面から写す（読めた分だけ）。
 * ★添付が続けて2回取れなければ、ログインが切れたとみなして止める（移植元と同じ規則）。
 */
const errorText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "失敗しました");

export async function fetchComposedParts(
  run: FetchRun,
  fields: Record<string, string>,
): Promise<RememberedRoute | null> {
  const { page, kind, tenant, log, send } = run;
  const compose = kind.compose;
  if (!compose) return null;
  const linkedKind: RakurakuKind = run.linkedKind ?? KINDS[compose.linkedKind];
  const llabel = linkedKind.label;
  const lno = normalizeDenpyoDigits(fields[compose.linkKey] ?? run.request.linkedNo ?? null);

  let linkReason: string | null = null;
  let plan = composeNatsuinParts([], compose.rules);
  let picked: { index: number; name: string; group: "decision" | "summary" | "estimate" | "other" }[] = [];

  const finish = async () => {
    if (linkReason) log(`  ! ${linkReason}`);
    await send({
      type: "compose",
      linkedNo: lno,
      pattern: plan.pattern,
      picked,
      paren: plan.paren,
      parenFrom: plan.parenFrom,
      finalName: natsuinFinalName(plan, compose.rules, run.request.denpyoNo, kind.filePrefix),
      linkReason,
    });
  };

  if (!lno) {
    linkReason = `${llabel}№を読めませんでした`;
    await finish();
    return null;
  }

  // --- 紐づく伝票を一覧から探す（★部門は一覧を開く直前に毎回確かめる）
  run.progress("navigate", `紐づく${llabel}を探しています`);
  log(`  紐づく${llabel} No.${lno} を探します`);
  let row: { denpyoNo: string; href: string | null; status: string } | null = null;
  let linkedRoute = linkedKind.routes[0];
  let remembered: RememberedRoute | null = null;
  try {
    await openHome(page, tenant, run.home);
    if (run.request.deptCode !== null) {
      await applyDepartment(page, run.request.deptCode, { log, reopenUrl: run.home, ...run.timing?.department });
    }
    // ★紐づく種類には画面の固定を持ち込まない（別の種類なので、開ける経路は自動で選ぶ）
    const location = await gotoList(page, linkedKind, tenant, {
      log,
      remembered: run.linkedRemembered ?? null,
      // ★固定は持ち込まないが、アカウントに「閲覧」タブが無いことは別の種類でも同じ
      viewTab: run.viewTab,
      home: run.home,
      timing: run.timing?.navigation,
      onRoute: (r, how) => run.onRoute?.(linkedKind.id, r, how),
    });
    linkedRoute = location.route;
    remembered = rememberedOf(location);
    row = location.empty
      ? null
      : await scanListForNo(page, resolveKind(linkedKind, linkedRoute), lno, {
          maxPages: compose.maxLinkPages,
          timing: run.timing?.list ?? defaultTiming(linkedKind),
          log,
        });
  } catch (e) {
    if (e instanceof RakurakuError && e.sessionLost) throw e;
    linkReason = `${llabel}の一覧を開けませんでした（${errorText(e)}）`;
    await finish();
    return null;
  }
  if (!row) {
    // ★申請検索の一覧は自分が申請した伝票しか出ない。ほかの人が申請した伝票は見つからないので、理由に添える
    const scopeNote = linkedRoute.scope === "own" ? "（申請検索の一覧は自分が申請した伝票だけが対象です）" : "";
    linkReason = `${llabel} No.${lno} が${llabel}の一覧に見つかりませんでした${scopeNote}`;
    await finish();
    return remembered;
  }
  await send({ type: "linked.found", denpyoNo: row.denpyoNo, href: row.href });

  // --- 紐づく伝票の画面: 項目 → 本体 → 添付
  const detailOptions = { log, timing: run.timing?.detail };
  const resolvedLinked = resolveKind(linkedKind, linkedRoute);
  let frame = await openDetail(page, resolvedLinked, tenant, row.denpyoNo, row.href, detailOptions);
  const href = row.href ?? frame.url();

  try {
    const lfields = await readDetailFields(frame, linkedKind);
    const copied = Object.fromEntries(compose.copyFromLinked.filter((key) => lfields[key]).map((key) => [key, lfields[key]]));
    if (Object.keys(copied).length > 0) {
      await send({ type: "linked.fields", fields: copied });
      log(`  ${llabel}から写した項目: ${Object.keys(copied).join(" / ")}`);
    }
  } catch (e) {
    log(`    （${llabel}の項目を読めませんでした: ${e instanceof Error ? e.name : "Error"}）`);
  }

  run.progress("body", `${llabel}の本体PDFを取得しています`);
  const downloadTiming = run.timing?.download ?? defaultDownloadTiming(linkedKind);
  for (const attempt of [1, 2]) {
    try {
      const body = await fetchBodyPdf(page, frame, linkedKind, tenant, log, downloadTiming);
      await sendFile(send, { role: "linked-body", index: 0, name: `${llabel} 本体（No.${lno}）`, ext: extOf(body.name), bytes: body.bytes });
      break;
    } catch (e) {
      if (e instanceof RakurakuError && e.sessionLost) throw e;
      if (attempt === 2) {
        // ★本体が取れなくても、添付は取れるだけ取る
        linkReason = `${llabel}の本体PDFを取れませんでした（${errorText(e)}）`;
        break;
      }
      log(`    ! 取れなかったので開き直してもう一度試します（${errorText(e)}）`);
    }
    frame = await openDetail(page, resolvedLinked, tenant, row.denpyoNo, href, detailOptions);
  }

  // --- 添付の選別
  run.progress("attachments", `${llabel}の添付を取得しています`);
  const attachments = await locateAttachments(frame, linkedKind);
  const names = attachments.map((a) => a.name);
  await send({ type: "linked.attachments", names });
  plan = composeNatsuinParts(names, compose.rules);
  const used = new Set<number>();
  picked = plan.picked.map((p) => {
    // ★同じ名前の添付が並んでいても、それぞれ別の添付として数える
    const item = attachments.find((a) => a.name === p.name && !used.has(a.index));
    const index = item?.index ?? 0;
    if (item) used.add(item.index);
    return { index, name: p.name, group: p.group };
  });
  log(`  ${llabel}の添付 ${names.length}件 → 結合するもの ${picked.length}件`);

  const timeoutMs = run.timing?.attachmentTimeoutMs ?? 60_000;
  const intervalMs = run.timing?.requestIntervalMs ?? 1_500;
  let misses = 0;
  for (const [i, target] of picked.entries()) {
    const item = attachments.find((a) => a.index === target.index);
    if (run.attachmentDeadlineAt !== undefined && Date.now() >= run.attachmentDeadlineAt) {
      for (const rest of picked.slice(i)) {
        await send({
          type: "attachment.failed",
          role: "linked-attachment",
          index: rest.index,
          name: rest.name,
          code: "TIME_BUDGET_EXCEEDED",
          reason: "時間の上限が近いので、この添付は続けて個別に取得します",
          retryable: true,
        });
      }
      log(`  （時間の上限が近いので、残りの${llabel}の添付は個別に取得します）`);
      break;
    }
    if (!item) continue;
    try {
      const file = await fetchAttachment(page, item, timeoutMs);
      await sendFile(send, { role: "linked-attachment", index: item.index, name: item.name, ext: file.ext, bytes: file.bytes });
      log(`    ${llabel}の添付 ${item.index}件目を取得しました（${file.ext || "拡張子なし"}）`);
      misses = 0;
    } catch (e) {
      if (e instanceof RakurakuError && e.sessionLost) throw e;
      const reason = errorText(e);
      await send({ type: "attachment.failed", role: "linked-attachment", index: item.index, name: item.name, code: "ATTACHMENT_FAILED", reason, retryable: true });
      log(`    ! ${llabel}の添付 ${item.index}件目を取得できませんでした（${reason}）`);
      misses += 1;
      if (misses >= 2) {
        throw new RakurakuError("ATTACHMENT_FAILED", "添付の取得が続けて失敗しました（ログインが切れた可能性があります）", { sessionLost: true });
      }
    }
    if (intervalMs > 0) await page.waitForTimeout(intervalMs);
  }
  await finish();
  return remembered;
}
