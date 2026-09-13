import "server-only";
import type { Frame, Page } from "playwright-core";
import { contentFrame } from "./frames";
import type { RakurakuKind } from "./kinds";
import type { Log } from "./list";
import { pickLatestDate } from "./parse/datetime";
import { diffAddedLines, pickFinalApprovedAt, tableContentKey } from "./parse/tables";
import { escapeRegExp } from "./parse/text";
import { scanTablesEverywhere, scanTextEverywhere } from "./tables";

/**
 * 伝票画面の「承認履歴」から最終承認日を読む。
 *
 * 移植元: tenmatsu.py 2359-2377（open_approval_log）、4334-4436（read_final_approved_at）
 *
 * ★承認履歴の構造は実画面で未確認。表のセレクタに頼らず、クリックの後に**現れた表**を全部見る。
 */

const POLL_MS = 400;
/** 承認履歴の表を探す範囲（どの表でも見る） */
const LOG_TABLE_SELECTOR = "table";

/**
 * 伝票画面の「承認履歴」を開く。開けたら true。
 *
 * 実画面では onclick を持たないボタンなので、設定のセレクタが当たらなければ役割（button）→ 文字の順に探す。
 * ★クリックの待ち時間を必ず縮める（既定5秒）。30秒のままだと、押せない状態のときに1件あたり30秒止まり、
 *   41件で20分以上かかった。
 * ※移植元は隠れている要素も候補にしていた。閉じているダイアログの見出し「承認履歴」を先に掴むと
 *   押せずに時間切れになるので、**見えているもの**だけから選ぶ。
 */
export async function openApprovalLog(frame: Frame, kind: RakurakuKind): Promise<boolean> {
  const d = kind.detail;
  const text = new RegExp(escapeRegExp(d.approvalLogText));
  const candidates = [
    frame.locator(d.approvalLogSelector),
    frame.getByRole("button", { name: text }),
    frame.getByText(text),
  ];
  for (const candidate of candidates) {
    const visible = candidate.filter({ visible: true });
    if ((await visible.count().catch(() => 0)) === 0) continue;
    await visible.first().click({ timeout: d.approvalLogClickTimeoutMs });
    return true;
  }
  return false;
}

export interface ApprovalLogResult {
  /** 最終承認日。読めなければ null */
  value: string | null;
  /**
   * 承認履歴を開いたか。★開いたなら、使う側は伝票画面を開き直すこと。
   *   ダイアログが「印刷」ボタンに重なるとクリックできなくなる。ダイアログの「閉じる」は押さない
   *   （構造が未確認で、窓ごと閉じてしまう伝票画面の「閉じる」と紛れる恐れがあるため）。
   */
  opened: boolean;
}

/**
 * 伝票画面の「承認履歴」を開いて最終承認日を読む。
 *
 * ★**絶対に例外を投げない**。1件の最終承認日が取れないことで、取得できたPDFの処理や記録を落としてはいけない。
 * ★**クリック後に現れた表だけ**を見る。伝票画面には元から「承認ルート」（日付はあるが時刻が無い）があり、
 *   そこから採ると時刻の無い値や別の日付を返す（実バグ。多くの記録が日付だけになった）。
 * ★決まった時間だけ待つのではなく、日付の読める表が現れたら先へ進む（速い画面では待たない）。
 * ★自分が開かせた別ウィンドウは閉じる。伝票画面には触らない。
 */
export async function readFinalApprovedAt(
  page: Page,
  kind: RakurakuKind,
  log: Log,
  options: { waitMs?: number } = {},
): Promise<ApprovalLogResult> {
  const d = kind.detail;
  if (!d.readApprovalLog) return { value: null, opened: false };
  const waitMs = options.waitMs ?? d.approvalLogWaitMs;
  const pagesBefore = new Set(page.context().pages());
  const pick = { dateColumns: d.approvalLogDateColumns, excludeWords: d.approvalLogExcludeWords, keywords: d.approvalLogKeywords };

  try {
    const frame = await contentFrame(page);
    const before = new Set((await scanTablesEverywhere(page)).map(tableContentKey));
    const beforeText = await scanTextEverywhere(page);

    if (!(await openApprovalLog(frame, kind))) {
      log("    （「承認履歴」が見つからないので最終承認日は空欄にします）");
      return { value: null, opened: false };
    }

    let got: string | null = null;
    const deadline = Date.now() + waitMs;
    for (;;) {
      got = pickFinalApprovedAt(await scanTablesEverywhere(page, before, LOG_TABLE_SELECTOR), { ...pick, requireNew: true });
      if (got || Date.now() >= deadline) break;
      await page.waitForTimeout(POLL_MS);
    }

    if (!got && d.approvalLogTextFallback) {
      // 表として読めない作り（<ul> や <div> の羅列）だったときの最後の手段。
      // ★クリック後に増えた行だけを見る（元からある「支払予定日」等を拾わないため）
      const lines = diffAddedLines(beforeText, await scanTextEverywhere(page));
      const joined = lines.join("\n");
      if (d.approvalLogKeywords.length === 0 || d.approvalLogKeywords.some((k) => joined.includes(k))) {
        got = pickLatestDate(lines, d.approvalLogExcludeWords);
      }
    }

    if (!got) {
      // 何が起きたのかを分かるようにする（表が現れていないのか、現れた表に日付の列が無いのか）
      const appeared = (await scanTablesEverywhere(page, before, LOG_TABLE_SELECTOR)).filter((t) => t.isNew);
      log(
        `    （承認履歴から日付を読めませんでした。最終承認日は空欄にします。${waitMs}ミリ秒待って、クリック後に現れた表は ${appeared.length}個）`,
      );
      if (appeared.length > 0) {
        const heads = appeared
          .slice(0, 2)
          .map((t) => (t.rows[0] ?? []).slice(0, 6).join(" "))
          .join(" / ");
        log(`      現れた表の先頭行: ${heads}（日付の列の見出しが変わった可能性があります）`);
      }
    }
    return { value: got, opened: true };
  } catch (e) {
    log(`    （承認履歴を読めませんでした: ${e instanceof Error ? e.name : "Error"}）`);
    // ★クリック済みかどうか分からないので「開いた」側に倒す。
    //   余分に伝票画面を開き直すだけで済み、ダイアログが残る事故を防げる
    return { value: null, opened: true };
  } finally {
    for (const other of page.context().pages()) {
      if (!pagesBefore.has(other)) await other.close().catch(() => null);
    }
  }
}
