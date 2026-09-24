import { NextResponse } from "next/server";
import { type ContactResponse, handleContact } from "@/lib/contact/handle";
import { createRateLimiter } from "@/lib/contact/rate-limit";
import { sendWithResend } from "@/lib/contact/send";
import { assertSameOrigin } from "@/lib/rakuraku/guard";
import { requireSignedIn } from "@/lib/account/current";

/**
 * 問い合わせ（不具合・要望）を開発者へメールで送る口。
 * ★送り先は環境変数 CONTACT_TO だけが持つ（公開リポジトリなのでコードに書かない）。
 * ★中身をログに書かない。Folio のログイン（proxy.ts）を通った人だけが呼べる。
 */
export const maxDuration = 30;
export const dynamic = "force-dynamic";

/** 1つのインスタンスで 10分に5通まで（連打・いたずらを止める。本当の上限は Resend の1日100通） */
const limiter = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
/** ★Vercel の関数が受け取れるのは 4.5MB まで。読む前に断る */
const MAX_BODY_BYTES = 4_400_000;

const json = (status: number, body: ContactResponse) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  // ★proxy だけに頼らず、ここでもログインを確かめる（署名と期限。仮のパスワードの人は通さない）
  const signed = await requireSignedIn(request);
  if (!signed.ok) return signed.response;
  try {
    assertSameOrigin(request);
  } catch {
    return json(403, { ok: false, code: "BAD_REQUEST", message: "別のサイトからは送れません" });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return json(413, { ok: false, code: "TOO_LARGE", message: "写真が大きすぎます。枚数を減らしてください" });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { ok: false, code: "BAD_REQUEST", message: "中身を読めませんでした" });
  }
  const result = await handleContact(
    form,
    {
      apiKey: process.env.RESEND_API_KEY,
      to: process.env.CONTACT_TO,
      from: process.env.CONTACT_FROM,
      commit: process.env.VERCEL_GIT_COMMIT_SHA,
      environment: process.env.VERCEL_ENV,
      account: signed.id,
    },
    { send: sendWithResend, limiter, now: Date.now },
  );
  // ★送れた／送れなかったの種類だけを残す（中身は書かない）
  if (!result.body.ok) console.error(`[contact] ${result.body.code}`);
  return json(result.status, result.body);
}
