import { RakurakuError } from "@/lib/rakuraku/errors";
import { fetchOne } from "@/lib/rakuraku/fetch-one";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { KINDS } from "@/lib/rakuraku/kinds";
import { log } from "@/lib/rakuraku/log";
import { parseFetchRequest } from "@/lib/rakuraku/protocol";
import { unseal } from "@/lib/rakuraku/session";
import { withSessionPage } from "@/lib/rakuraku/session-browser";
import { ndjsonResponse } from "@/lib/rakuraku/stream";

/**
 * 伝票1件を取得する。**1伝票＝1呼び出し**（途中で落ちても、それまでの伝票はブラウザが保存済み）。
 *
 * 流れ: トップを開く → 伝票画面を開く → 項目と最終承認日を読む → 本体PDF → 添付
 * 返すもの（行ごとの JSON）: progress / log … → fields → file.*（本体）→ attachments →
 *   file.*（添付）/ attachment.failed … → session → done
 *
 * ★楽楽精算に対しては**閲覧とダウンロードだけ**を行う。何も書き換えない。
 * ★保存も記録もしない。PDF は Folio のサーバーを通るだけで、ここには残らない。
 * ★ログインはしない。切れていたら SESSION_EXPIRED を返す。
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** 予算。maxDuration より短くして、必ず最後の行を返せるようにする */
const BUDGET_MS = 270_000;
/** 残りがこれを切ったら、次の添付は取りに行かない（添付1件のダウンロード待ち60秒＋間隔） */
const ATTACHMENT_RESERVE_MS = 70_000;

export async function POST(request: Request) {
  const started = Date.now();
  // 本文は応答を流し始める前に読んでおく
  const raw: unknown = await request.json().catch(() => null);

  return ndjsonResponse(
    request,
    async (sink) => {
      assertSameOrigin(request);
      const tenant = assertEnabled();
      const parsed = parseFetchRequest(raw);
      if (!parsed.ok) throw new RakurakuError("BAD_REQUEST", parsed.message);
      const body = parsed.value;
      const session = unseal(body.sessionToken);
      const kind = KINDS[body.kind];

      await withSessionPage(sink, session, async ({ page }) => {
        const result = await fetchOne({
          page,
          tenant,
          home: session.home,
          kind,
          request: body,
          listUrlFound: session.lists?.[kind.id] ?? null,
          log: sink.log,
          progress: sink.progress,
          send: sink.send,
          attachmentDeadlineAt: started + BUDGET_MS - ATTACHMENT_RESERVE_MS,
        });
        log("detail", { ok: true, ms_elapsed: Date.now() - started });
        return result.foundUrl ? { lists: { [kind.id]: result.foundUrl } } : undefined;
      });
    },
    { stage: "detail", startedAt: started },
  );
}
