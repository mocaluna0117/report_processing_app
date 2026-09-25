import "server-only";
import type { LoginPurpose, Refusal, CredentialStateStore, FailReason } from "./credential-state";
import type { LoginCode } from "./login";
import type { RakurakuCode } from "./protocol";

/**
 * 登録したIDとパスワードで楽楽精算にログインする流れ（2026-09-25）。
 *
 * 順: 決まりを確かめて「始めた」と書く → ログイン画面を開く → 打つ直前に「送った」と書く → 打つ →
 *     着いた画面で確かめる → 結果（成功・失敗・送っていない）を書く。
 * ★楽楽精算に触る部分（ブラウザ）は attempt として外から受け取る（ここは決まりだけ。テストで確かめる）。
 * ★送ったあとで例外になったものは、成功したか分からないので失敗として数える。
 * ★やり直さない。失敗したら理由を返して止める。
 */

export type AttemptResult<T> =
  | { code: "OK"; value: T }
  | { code: Exclude<LoginCode, "OK">; message: string; submitted: boolean };

export type GuardedLoginResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RakurakuCode; message: string; retryable: boolean };

export interface GuardedLoginInput {
  states: CredentialStateStore;
  folioId: string;
  purpose: LoginPurpose;
  /** 自動のときは控えの版。確かめて保存のときは null */
  ver: string | null;
  /** 確かめて保存に成功したときの新しい版 */
  newVer?: string;
  now: () => number;
}

/** 断ったときの文 */
export function refusalMessage(code: Refusal, purpose: LoginPurpose, waitMs = 0): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  switch (code) {
    case "CREDENTIAL_MISSING":
      return "楽楽精算のIDとパスワードが登録されていません。アカウントの画面で登録してください";
    case "CREDENTIAL_STALE":
      return "このPCの楽楽精算の登録は使えなくなっています（ほかの画面で入れ直したか、消しました）。アカウントの画面で入れ直してください";
    case "CREDENTIAL_REJECTED":
      return "前回、登録したIDとパスワードで楽楽精算にログインできませんでした。楽楽精算のアカウントがロックされないよう、自動ではログインしません。アカウントの画面で入れ直してください";
    case "LOGIN_IN_PROGRESS":
      return "ほかの画面で楽楽精算にログインしている最中です。少し待ってから、もう一度押してください";
    case "LOGIN_COOLDOWN":
      return `直前のログインに失敗しています。${seconds}秒あけてから、もう一度押してください`;
    case "LOGIN_LIMIT":
      return purpose === "auto"
        ? "今日の自動のログインの回数の上限に達しました。明日もう一度試すか、開発者に知らせてください"
        : `続けてログインできませんでした。楽楽精算の画面で直接ログインできるか確かめてから、${minutes}分後にもう一度試してください`;
  }
}

/** ログインの結果の文（アカウントの画面で確かめるときと、取得のときで言い方を変える） */
export function attemptFailureMessage(code: Exclude<LoginCode, "OK">, purpose: LoginPurpose, fallback: string): string {
  if (code === "LOGIN_FAILED") {
    return purpose === "verify"
      ? "楽楽精算にログインできませんでした（IDかパスワードが違う可能性があります）。登録はしていません。入力を確かめてください"
      : "登録したIDとパスワードで楽楽精算にログインできませんでした。自動ではやり直しません。楽楽精算のパスワードを変えたときは、アカウントの画面で入れ直してください";
  }
  if (code === "LOGIN_UNCONFIRMED") {
    return "楽楽精算にログインできたか確かめられませんでした（いつもの画面になりませんでした）。自動ではやり直しません。楽楽精算の画面で直接ログインできるか確かめてから、アカウントの画面で入れ直してください";
  }
  if (code === "LOGIN_ABORTED") {
    return "楽楽精算へのログインを取りやめました（登録が変わったか、Folio の置き場所に届きませんでした）。少し待ってから、もう一度押してください";
  }
  return fallback;
}

export async function guardedLogin<T>(
  input: GuardedLoginInput,
  attempt: (beforeSubmit: () => Promise<boolean>) => Promise<AttemptResult<T>>,
): Promise<GuardedLoginResult<T>> {
  const { states, folioId, purpose } = input;
  const started = await states.start(folioId, { purpose, ver: input.ver, now: input.now() });
  if (!started.ok) {
    return { ok: false, code: started.code, message: refusalMessage(started.code, purpose, started.waitMs), retryable: false };
  }
  const { attemptId } = started;
  let submitted = false;
  const beforeSubmit = async () => {
    submitted = await states.markSubmitted(folioId, attemptId, input.now()).catch(() => false);
    return submitted;
  };

  let result: AttemptResult<T>;
  try {
    result = await attempt(beforeSubmit);
  } catch (e) {
    // ★送ったあとの例外は、成功したか分からない → 失敗として数える
    const outcome = submitted ? { kind: "failed" as const, reason: "UNKNOWN_OUTCOME" as FailReason } : { kind: "not-sent" as const };
    await states.finish(folioId, attemptId, outcome, input.now()).catch(() => null);
    throw e;
  }

  if (result.code === "OK") {
    const written = await states.finish(folioId, attemptId, { kind: "ok", newVer: input.newVer }, input.now()).catch(() => null);
    // ★確かめて保存は、新しい版を書けなければ登録として使えない（控えの版とずれる）
    if (!written && purpose === "verify") {
      return {
        ok: false,
        code: "CREDENTIAL_NOT_SAVED",
        message: "楽楽精算にはログインできましたが、登録を書き込めませんでした。少し待ってから、もう一度押してください",
        retryable: false,
      };
    }
    return { ok: true, value: result.value };
  }

  const sent = result.submitted && submitted;
  if (sent) {
    const reason: FailReason = result.code === "LOGIN_UNCONFIRMED" ? "LOGIN_UNCONFIRMED" : result.code === "LOGIN_FAILED" ? "LOGIN_FAILED" : "UNKNOWN_OUTCOME";
    await states.finish(folioId, attemptId, { kind: "failed", reason }, input.now()).catch(() => null);
  } else {
    await states.finish(folioId, attemptId, { kind: "not-sent" }, input.now()).catch(() => null);
  }
  // ★ログインの失敗は、どれもブラウザに自動でやり直させない（押し直すのは人）
  return { ok: false, code: result.code, message: attemptFailureMessage(result.code, purpose, result.message), retryable: false };
}
