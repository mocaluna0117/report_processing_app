import { RakurakuError } from "@/lib/rakuraku/errors";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { KINDS } from "@/lib/rakuraku/kinds";
import { log } from "@/lib/rakuraku/log";
import { parseScanRequest } from "@/lib/rakuraku/protocol";
import { runScan } from "@/lib/rakuraku/scan";
import { unseal } from "@/lib/rakuraku/session";
import { withSessionPage } from "@/lib/rakuraku/session-browser";
import { ndjsonResponse } from "@/lib/rakuraku/stream";

/**
 * 一覧から、取得する伝票（承認済みで、まだ取っていないもの）を見つける。
 *
 * 流れ: トップを開く → 部門を確かめる → 一覧へ移動 → ページを送りながら対象を集める。
 * 返すもの（行ごとの JSON）: progress / log … → targets → session（新しいログイン状態）→ done
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

      await withSessionPage(sink, session, async ({ page }) => {
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
        return result.foundUrl ? { lists: { [kind.id]: result.foundUrl } } : undefined;
      });
    },
    { stage: "list", startedAt: started },
  );
}
