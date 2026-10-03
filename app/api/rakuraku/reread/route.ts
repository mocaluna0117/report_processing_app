import { RakurakuError } from "@/lib/rakuraku/errors";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { KINDS } from "@/lib/rakuraku/kinds";
import { pinnedRoute } from "@/lib/rakuraku/navigation";
import { log } from "@/lib/rakuraku/log";
import { parseRereadRequest } from "@/lib/rakuraku/protocol";
import { rereadDetails } from "@/lib/rakuraku/reread";
import { unseal } from "@/lib/rakuraku/session";
import { withSessionPage } from "@/lib/rakuraku/session-browser";
import { ndjsonResponse } from "@/lib/rakuraku/stream";
import { requireSignedIn } from "@/lib/account/current";
import { sessionSubjectOf } from "@/lib/rakuraku/subject";

/**
 * 取得済みの伝票の画面を開き直して、項目だけを読み直す（2026-10-03。支払金額(税抜)を後から埋めるため）。
 *
 * 流れ: トップを開く → 一覧を1回読んで伝票画面の URL を集める → 伝票ごとに開いて項目を読む
 * 返すもの（行ごとの JSON）: progress / log … → detail.fields / detail.failed … → session → done
 *
 * ★楽楽精算に対しては**閲覧だけ**。PDF も添付も取らない。何も書き換えない。
 * ★保存も記録もしない（ブラウザが記録に足す）。
 * ★ログインはしない。切れていたら SESSION_EXPIRED を返す。
 * ★利用状況には成功を数えない（「取得した伝票の数」を膨らませない）。失敗は今までどおり数える。
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** 予算。maxDuration より短くして、必ず最後の行を返せるようにする */
const BUDGET_MS = 270_000;
/** 伝票1件を開いて読むのにかかる最大の見込み（伝票画面の待ち20秒＋描画8秒＋余裕） */
const DETAIL_RESERVE_MS = 40_000;

export async function POST(request: Request) {
  // ★proxy だけに頼らず、ここでもログインを確かめる（署名と期限。仮のパスワードの人は通さない）
  const signed = await requireSignedIn(request);
  if (!signed.ok) return signed.response;
  const started = Date.now();
  const raw: unknown = await request.json().catch(() => null);

  return ndjsonResponse(
    request,
    async (sink) => {
      assertSameOrigin(request);
      const tenant = assertEnabled();
      const parsed = parseRereadRequest(raw);
      if (!parsed.ok) throw new RakurakuError("BAD_REQUEST", parsed.message);
      const body = parsed.value;
      // ★持ち主（Folio のアカウント）が違う札は断る
      const session = unseal(body.sessionToken, sessionSubjectOf(signed.id));
      const kind = KINDS[body.kind];
      const pin = body.route ? pinnedRoute(kind, body.route).id : null;

      await withSessionPage(sink, session, async ({ page }) => {
        const result = await rereadDetails({
          page,
          tenant,
          home: session.home,
          kind,
          denpyoNos: body.denpyoNos,
          deptCode: body.deptCode,
          remembered: session.routes?.[kind.id] ?? null,
          pin,
          viewTab: session.viewTab,
          deadlineAt: started + BUDGET_MS - DETAIL_RESERVE_MS,
          log: sink.log,
          progress: sink.progress,
          send: sink.send,
          onRoute: (id, route, how) =>
            void sink.send({ type: "route", kind: id, route: route.id, label: route.label, scope: route.scope, how }),
        });
        log("detail", { ok: true, ms_elapsed: Date.now() - started, n_requested: body.denpyoNos.length });
        return { routes: result.remembered ? { [kind.id]: result.remembered } : {} };
      }, { tenant });
    },
    { stage: "detail", startedAt: started, usage: { id: signed.id, ok: null } },
  );
}
