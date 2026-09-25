import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/account/current";
import { isSameOriginPost, originInputOf } from "@/lib/account/origin";
import { verifyPassword } from "@/lib/account/password";
import { browserLogin } from "@/lib/rakuraku/browser-login";
import {
  CredentialError,
  RAKURAKU_ID_MAX,
  RAKURAKU_PASSWORD_MAX,
  credentialIdHint,
  credentialKey,
  newCredentialVer,
  sealCredential,
} from "@/lib/rakuraku/credential";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { GuardError, assertEnabled } from "@/lib/rakuraku/guard";
import { log } from "@/lib/rakuraku/log";
import { guardedLogin } from "@/lib/rakuraku/stored-login";
import { resolveSubject } from "@/lib/rakuraku/subject";

/**
 * 楽楽精算のIDとパスワードの登録（アカウントの画面から。2026-09-25）。
 *
 * - GET: この人の自動ログインの状態（登録の版・失敗の回数・最後にログインできた時刻）。★秘密は返さない
 * - POST: 「ログインできるか確かめて保存」。**1回だけ**ログインしてみて、できたときだけ控えを作って返す
 *   （控えはブラウザの IndexedDB に置く。サーバーには置かない）。できなければ何も作らない
 * - DELETE: 登録を消す（ほかの画面の控えも使えなくなる）
 *
 * ★パスワードはこの中でだけ使い、記録しない・画面へ返さない（返すのは暗号にした控えだけ）。
 * ★本人だけが自分の分を入れる（Folio のログインの持ち主に結び付く。管理者がほかの人の分を入れる口は無い）。
 */
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const BUDGET_MS = 90_000;

const reply = (body: Record<string, unknown>) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
const fail = (code: string, message: string) => reply({ ok: false, code, message, retryable: false });

async function signedSubject(request: Request, write: boolean) {
  const signed = await requireSignedIn(request);
  if (!signed.ok) return { ok: false as const, response: signed.response };
  if (write && !isSameOriginPost(originInputOf(request))) {
    return { ok: false as const, response: fail("FORBIDDEN_ORIGIN", "別のサイトからは呼べません") };
  }
  const subject = await resolveSubject(request);
  if (!subject.ok) return { ok: false as const, response: subject.response };
  return subject;
}

export async function GET(request: Request) {
  const subject = await signedSubject(request, false);
  if (!subject.ok) return subject.response;
  try {
    const state = await subject.states.get(subject.binding.folioId, Date.now());
    return reply({
      ok: true,
      state: {
        ver: state.ver,
        failures: state.failures,
        lastOkAt: state.lastOkAt,
        lastFailAt: state.lastFailAt,
        lastFailReason: state.lastFailReason,
        busy: state.inFlight !== null,
      },
    });
  } catch {
    return fail("INTERNAL", "楽楽精算の登録の状態を読めませんでした。少し待ってから読み込み直してください");
  }
}

export async function POST(request: Request) {
  const started = Date.now();
  const subject = await signedSubject(request, true);
  if (!subject.ok) return subject.response;
  let tenant;
  try {
    tenant = assertEnabled();
    credentialKey();
  } catch (e) {
    if (e instanceof CredentialError) return fail("DISABLED", e.message);
    return fail(e instanceof GuardError ? e.code : "INTERNAL", e instanceof GuardError ? e.message : "失敗しました");
  }

  // ★本文を読めないときは決まった文だけを返す（JSON のエラー文は本文＝パスワードをそのまま繰り返すため）
  let body: { userId?: unknown; password?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("BAD_REQUEST", "本文を読めませんでした");
  }
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!userId || !password) return fail("BAD_REQUEST", "楽楽精算のログインIDとパスワードを入れてください");
  if (userId.length > RAKURAKU_ID_MAX || password.length > RAKURAKU_PASSWORD_MAX) {
    return fail("BAD_REQUEST", "ログインIDかパスワードが長すぎます");
  }
  // ★ブラウザが Folio のパスワードを自動で入れてしまうことがある。そのまま送ると、楽楽精算に失敗が1回数えられる
  if (subject.folioHash && (await verifyPassword(password, subject.folioHash))) {
    return fail(
      "BAD_REQUEST",
      "Folio のパスワードと同じものが入っています（ブラウザが自動で入れた可能性があります）。楽楽精算のパスワードを入れてください。楽楽精算と Folio で同じパスワードを使っているときは、どちらかを変えてください",
    );
  }

  const ver = newCredentialVer();
  try {
    const result = await guardedLogin(
      { states: subject.states, folioId: subject.binding.folioId, purpose: "verify", ver: null, newVer: ver, now: Date.now },
      (beforeSubmit) =>
        browserLogin({
          tenant,
          credentials: { userId, password },
          sub: subject.binding.folioId,
          budgetMs: BUDGET_MS,
          started,
          beforeSubmit,
        }),
    );
    if (!result.ok) return fail(result.code, result.message);
    const savedAt = Date.now();
    const credential = sealCredential({ u: userId, p: password, ver, savedAt }, subject.binding);
    return reply({
      ok: true,
      credential,
      ver,
      idHint: credentialIdHint(userId),
      savedAt,
      ...result.value,
    });
  } catch (e) {
    const code = e instanceof RakurakuError ? e.code : "INTERNAL";
    log("login", { ok: false, code, ms_total: Date.now() - started });
    // ★例外の中身に資格情報が混ざらないよう、決まった文か1行目だけを短く返す
    return fail(code, e instanceof RakurakuError ? e.message.split("\n")[0].slice(0, 200) : "楽楽精算へのログインで失敗しました");
  }
}

export async function DELETE(request: Request) {
  const subject = await signedSubject(request, true);
  if (!subject.ok) return subject.response;
  try {
    await subject.states.unregister(subject.binding.folioId);
    return reply({ ok: true });
  } catch {
    return fail("INTERNAL", "登録を消せませんでした。少し待ってから、もう一度押してください");
  }
}
