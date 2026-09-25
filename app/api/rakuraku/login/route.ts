import { NextResponse } from "next/server";
import { isSameOriginPost, originInputOf } from "@/lib/account/origin";
import { requireSignedIn } from "@/lib/account/current";
import { browserLogin } from "@/lib/rakuraku/browser-login";
import { CREDENTIAL_SEALED_MAX, CredentialError, openCredential } from "@/lib/rakuraku/credential";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { GuardError, assertEnabled } from "@/lib/rakuraku/guard";
import { log } from "@/lib/rakuraku/log";
import { SessionError } from "@/lib/rakuraku/session";
import { guardedLogin } from "@/lib/rakuraku/stored-login";
import { resolveSubject } from "@/lib/rakuraku/subject";

/**
 * 登録した楽楽精算のIDとパスワード（このPCの控え）でログインし、その状態を封じた `sessionToken` を返す。
 *
 * ★ログインIDとパスワードは受け取らない（2026-09-25 から。古いタブから来ても無視する）。
 *   受け取るのは控え（Folio のサーバーの鍵で暗号にしたもの）だけ。開くのはこの中だけで、どこにも残さない・記録しない。
 * ★自動でログインしてよいかは lib/rakuraku/credential-state.ts の決まりで決める。
 *   1回でも失敗したら、アカウントの画面で入れ直すまで自動ではログインしない（楽楽精算のアカウントロックを避ける）。
 * ★失敗しても自動でやり直さない。
 */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** 予算。maxDuration より短くして、必ず答えを返せるようにする */
const BUDGET_MS = 90_000;

function fail(code: string, message: string, status = 200) {
  return NextResponse.json({ ok: false, code, message, retryable: false }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // ★proxy だけに頼らず、ここでもログインを確かめる（署名と期限。仮のパスワードの人は通さない）
  const signed = await requireSignedIn(request);
  if (!signed.ok) return signed.response;
  const started = Date.now();
  // ★登録を使う口は、同じサイトから送られたと確かめられないものを断る（閉じる側に倒す）
  if (!isSameOriginPost(originInputOf(request))) return fail("FORBIDDEN_ORIGIN", "別のサイトからは呼べません");
  let tenant;
  try {
    tenant = assertEnabled();
  } catch (e) {
    const code = e instanceof GuardError ? e.code : "INTERNAL";
    log("route", { ok: false, code });
    return fail(code, e instanceof GuardError ? e.message : "失敗しました");
  }

  // ★本文を読めないときは決まった文だけを返す（JSON のエラー文は本文をそのまま繰り返すため）
  let credential: unknown;
  try {
    credential = ((await request.json()) as { credential?: unknown } | null)?.credential;
  } catch {
    return fail("BAD_REQUEST", "本文を読めませんでした");
  }
  if (typeof credential !== "string" || credential.length === 0) {
    return fail("CREDENTIAL_MISSING", "楽楽精算のIDとパスワードが登録されていません。アカウントの画面で登録してください");
  }
  if (credential.length > CREDENTIAL_SEALED_MAX) return fail("BAD_REQUEST", "本文が長すぎます");

  const subject = await resolveSubject(request);
  if (!subject.ok) return subject.response;

  let secret;
  try {
    secret = openCredential(credential, subject.binding);
  } catch (e) {
    const code = e instanceof CredentialError && e.code === "CREDENTIAL_KEY" ? "DISABLED" : "CREDENTIAL_UNREADABLE";
    log("login", { ok: false, code });
    return fail(code, e instanceof CredentialError ? e.message : "このPCの楽楽精算の登録を読めませんでした");
  }

  try {
    const result = await guardedLogin(
      { states: subject.states, folioId: subject.binding.folioId, purpose: "auto", ver: secret.ver, now: Date.now },
      (beforeSubmit) =>
        browserLogin({
          tenant,
          credentials: { userId: secret.u, password: secret.p },
          sub: subject.binding.folioId,
          budgetMs: BUDGET_MS,
          started,
          beforeSubmit,
        }),
    );
    if (!result.ok) {
      log("login", { ok: false, code: result.code, ms_total: Date.now() - started });
      return fail(result.code, result.message);
    }
    return NextResponse.json(
      { ok: true, ...result.value, totalMs: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const code = e instanceof RakurakuError ? e.code : e instanceof SessionError ? "SESSION_SECRET" : "INTERNAL";
    log("login", { ok: false, code, ms_total: Date.now() - started });
    // ★例外の中身に資格情報が混ざらないよう、決まった文か1行目だけを短く返す
    const message = e instanceof RakurakuError ? e.message.split("\n")[0].slice(0, 200) : "楽楽精算へのログインで失敗しました";
    return fail(code, message);
  }
}
