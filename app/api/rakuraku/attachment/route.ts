import { RakurakuError } from "@/lib/rakuraku/errors";
import { fetchOneAttachment } from "@/lib/rakuraku/fetch-one";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { KINDS } from "@/lib/rakuraku/kinds";
import { pinnedRoute } from "@/lib/rakuraku/navigation";
import { parseAttachmentRequest } from "@/lib/rakuraku/protocol";
import { unseal } from "@/lib/rakuraku/session";
import { withSessionPage } from "@/lib/rakuraku/session-browser";
import { ndjsonResponse } from "@/lib/rakuraku/stream";
import { requireSignedIn } from "@/lib/account/current";
import { sessionSubjectOf } from "@/lib/rakuraku/subject";

/**
 * 添付を1つだけ取り直す。`/fetch` の中で時間切れ（TIME_BUDGET_EXCEEDED）になった添付に使う。
 *
 * 返すもの（行ごとの JSON）: progress / log … → attachments → file.*（添付）→ session → done
 *
 * ★表示名が前回と違えば取らない（ATTACHMENT_MISMATCH）。別の書類を別の枠に入れないため。
 * ★楽楽精算に対しては閲覧とダウンロードだけを行う。
 */
export const maxDuration = 180;
export const dynamic = "force-dynamic";

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
      const parsed = parseAttachmentRequest(raw);
      if (!parsed.ok) throw new RakurakuError("BAD_REQUEST", parsed.message);
      const body = parsed.value;
      // ★持ち主（Folio のアカウント）が違う札は断る（ほかの人のログイン状態を使わせない）
      const session = unseal(body.sessionToken, sessionSubjectOf(signed.id));
      const kind = KINDS[body.kind];
      const pin = body.route ? pinnedRoute(kind, body.route).id : null;

      await withSessionPage(sink, session, async ({ page }) => {
        const result = await fetchOneAttachment(
          {
            page,
            tenant,
            home: session.home,
            kind,
            request: body,
            remembered: session.routes?.[kind.id] ?? null,
            pin,
            log: sink.log,
            progress: sink.progress,
            send: sink.send,
            onRoute: (id, route, how) =>
              void sink.send({ type: "route", kind: id, route: route.id, label: route.label, scope: route.scope, how }),
          },
          body.index,
          body.expectedName,
        );
        return { routes: result.routes };
      });
    },
    { stage: "download", startedAt: started },
  );
}
