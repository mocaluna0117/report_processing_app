import type { BrowserContext, BrowserContextOptions } from "playwright-core";
import { type LaunchedBrowser, launchBrowser } from "@/lib/rakuraku/browser";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { KINDS } from "@/lib/rakuraku/kinds";
import { log } from "@/lib/rakuraku/log";
import { parseScanRequest } from "@/lib/rakuraku/protocol";
import { runScan } from "@/lib/rakuraku/scan";
import { seal, unseal } from "@/lib/rakuraku/session";
import { ndjsonResponse } from "@/lib/rakuraku/stream";

/**
 * 一覧から、取得する伝票（承認済みで、まだ取っていないもの）を見つける。
 *
 * 流れ: トップを開く → 部門を確かめる → 一覧へ移動 → ページを送りながら対象を集める。
 * 返すもの（行ごとの JSON）: progress / log … → session（新しいログイン状態）→ targets → done
 *
 * ★楽楽精算に対しては**検索・閲覧だけ**を行う。何も書き換えない。
 * ★ログインはしない。封じたログイン状態が切れていたら SESSION_EXPIRED を返し、
 *   やり直すかどうかはブラウザ側が決める（自動でログインし直すとアカウントロックの恐れ）。
 * ★部門が選べない・一覧を開けないときは、**使おうとしたこの時点で**理由を返す（利用者の判断）。
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** 予算。maxDuration より短くして、必ず最後の行を返せるようにする */
const BUDGET_MS = 270_000;
/** 残りがこれを切ったら次のページへ進まない（1ページ読むのに、差し替え待ち15秒＋間隔など） */
const PAGE_RESERVE_MS = 45_000;

export async function POST(request: Request) {
  const started = Date.now();
  // 本文は応答を流し始める前に読んでおく
  const raw: unknown = await request.json().catch(() => null);

  return ndjsonResponse(
    request,
    async (sink) => {
      assertSameOrigin(request);
      const tenant = assertEnabled();
      const parsed = parseScanRequest(raw);
      if (!parsed.ok) throw new RakurakuError("BAD_REQUEST", parsed.message);
      const body = parsed.value;
      const session = unseal(body.sessionToken);
      const kind = KINDS[body.kind];

      let launched: LaunchedBrowser;
      try {
        launched = await launchBrowser();
      } catch (e) {
        throw new RakurakuError(
          "BROWSER_LAUNCH_FAILED",
          `ブラウザを起動できませんでした（${e instanceof Error ? e.name : "Error"}）`,
          { retryable: true },
        );
      }
      // ブラウザが接続を切ったら、待っている人はいないので楽楽精算の操作もすぐやめる
      sink.onAbort(() => void launched.close());

      let context: BrowserContext | null = null;
      const sendSession = async (lists = session.lists) => {
        if (!context) return;
        await sink.send({
          type: "session",
          // ★期限は延ばさない（exp を引き継ぐ）
          sessionToken: seal({ state: JSON.stringify(await context.storageState()), home: session.home, lists, exp: session.exp }),
        });
      };

      try {
        context = await launched.browser.newContext({
          storageState: JSON.parse(session.state) as BrowserContextOptions["storageState"],
        });
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);

        const result = await runScan({
          page,
          tenant,
          home: session.home,
          kind,
          request: body,
          listUrlFound: session.lists?.[kind.id] ?? null,
          log: sink.log,
          progress: sink.progress,
          deadlineAt: started + BUDGET_MS - PAGE_RESERVE_MS,
        });

        await sendSession(result.foundUrl ? { ...session.lists, [kind.id]: result.foundUrl } : session.lists);
        const { collect } = result;
        await sink.send({
          type: "targets",
          items: collect.targets,
          scanned: collect.scanned,
          pages: collect.pages,
          total: collect.total,
          last: collect.last,
          stoppedEarly: collect.stoppedEarly,
          reason: collect.reason,
          department: result.department,
        });
        log("list", { ok: true, n_targets: collect.targets.length, n_pages: collect.pages, n_scanned: collect.scanned });
      } catch (e) {
        // ログインが生きているなら、失敗しても新しいクッキーは渡しておく（入れ替わっていることがある）
        if (!(e instanceof RakurakuError && e.sessionLost)) await sendSession().catch(() => null);
        throw e;
      } finally {
        await launched.close();
      }
    },
    { stage: "list", startedAt: started },
  );
}
