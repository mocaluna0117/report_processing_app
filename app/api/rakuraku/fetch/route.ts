import { RakurakuError } from "@/lib/rakuraku/errors";
import { readDetailRecord } from "@/lib/rakuraku/fetch-one";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { KINDS } from "@/lib/rakuraku/kinds";
import { log } from "@/lib/rakuraku/log";
import { parseFetchRequest } from "@/lib/rakuraku/protocol";
import { unseal } from "@/lib/rakuraku/session";
import { withSessionPage } from "@/lib/rakuraku/session-browser";
import { ndjsonResponse } from "@/lib/rakuraku/stream";

/**
 * 伝票1件を取得する。**1伝票＝1呼び出し**。
 *
 * 流れ: トップを開く → 伝票画面を開く → 項目を読む → 承認履歴から最終承認日を読む
 * 返すもの（行ごとの JSON）: progress / log … → fields → session → done
 *
 * ★楽楽精算に対しては**閲覧だけ**を行う。何も書き換えない。
 * ★保存も記録もしない。Folio のサーバーには何も残らない（記録はブラウザが利用者のフォルダーに書く）。
 * ★ログインはしない。切れていたら SESSION_EXPIRED を返す。
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

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
        const record = await readDetailRecord({
          page,
          tenant,
          home: session.home,
          kind,
          request: body,
          listUrlFound: session.lists?.[kind.id] ?? null,
          log: sink.log,
          progress: sink.progress,
        });
        await sink.send({ type: "fields", fields: record.fields });
        log("detail", { ok: true, n_fields: Object.keys(record.fields).length });
        return record.foundUrl ? { lists: { [kind.id]: record.foundUrl } } : undefined;
      });
    },
    { stage: "detail", startedAt: started },
  );
}
