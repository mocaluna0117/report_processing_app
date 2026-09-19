import { RakurakuError } from "@/lib/rakuraku/errors";
import { assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { log } from "@/lib/rakuraku/log";
import { parseSurveyRequest } from "@/lib/rakuraku/protocol";
import { unseal } from "@/lib/rakuraku/session";
import { withSessionPage } from "@/lib/rakuraku/session-browser";
import { ndjsonResponse } from "@/lib/rakuraku/stream";
import { runSurvey } from "@/lib/rakuraku/survey";

/**
 * 「画面の下見」: 楽楽精算の**画面の作りだけ**を集めて、開発者へ渡す文面の材料を返す。
 *
 * アカウントによって使える画面が違う（「閲覧」タブが無い人がいる）ので、その人に自分のIDで
 * ログインして集めてもらう。返すもの（行ごとの JSON）: progress / log … → survey → session → done
 *
 * ★楽楽精算に対しては**閲覧だけ**を行う。伝票の中身・伝票No.・氏名・金額は集めない。
 *   押すのはタブの切り替え2つだけ（lib/rakuraku/survey.ts の ALLOWED_CLICKS）。
 * ★下見で開けた経路は覚えない（本番の取得の経路を、下見の結果で書き換えない）。
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** 予算。maxDuration より短くして、必ず最後の行を返せるようにする */
const BUDGET_MS = 240_000;

export async function POST(request: Request) {
  const started = Date.now();
  const raw: unknown = await request.json().catch(() => null);

  return ndjsonResponse(
    request,
    async (sink) => {
      assertSameOrigin(request);
      const tenant = assertEnabled();
      const parsed = parseSurveyRequest(raw);
      if (!parsed.ok) throw new RakurakuError("BAD_REQUEST", parsed.message);
      const body = parsed.value;
      const session = unseal(body.sessionToken);

      await withSessionPage(sink, session, async ({ page }) => {
        const report = await runSurvey({
          page,
          tenant,
          home: session.home,
          deptCode: body.deptCode,
          log: sink.log,
          progress: sink.progress,
          deadlineAt: started + BUDGET_MS,
        });
        await sink.send({ type: "survey", report });
        log("navigate", { ok: true, n_probes: report.probes.length, ms_elapsed: Date.now() - started });
      });
    },
    { stage: "navigate", startedAt: started },
  );
}
