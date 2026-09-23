import "server-only";
import { Resend } from "resend";

/**
 * 問い合わせのメールを Resend で送る。
 *
 * ★独自ドメインが無いので、送り元は onboarding@resend.dev（CONTACT_FROM で変えられる）。
 *   その場合、宛先は Resend のアカウントに登録したメールだけになる（CONTACT_TO をそれにする）。
 * ★Resend の返す文はそのまま画面へ出さない（宛先のアドレスが入ることがある）。種類だけ返す。
 */

export interface ContactMail {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer }[];
}

export type SendFailure =
  /** 鍵・宛先・送り元の設定が合っていない（利用者には直せない） */
  | "config"
  /** 1日・1か月の上限 */
  | "quota"
  /** Resend 側の回数の上限（少し待てば送れる） */
  | "rate"
  /** 待っても返事が無い */
  | "timeout"
  | "other";

export type SendResult = { ok: true } | { ok: false; failure: SendFailure };

/** 待つのはここまで（関数の時間の上限 30秒より短く） */
export const SEND_TIMEOUT_MS = 15_000;

const CONFIG_ERRORS = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "invalid_from_address",
  "invalid_access",
  "security_error",
]);

/** Resend のエラーの名前と HTTP の番号から、どういう失敗かを決める */
export function classifyResendError(error: { name?: string | null; statusCode?: number | null }): SendFailure {
  const name = error.name ?? "";
  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return "quota";
  if (name === "rate_limit_exceeded" || error.statusCode === 429) return "rate";
  // ★「自分のメール宛てにしか送れません」は 403 の validation_error で返る
  if (CONFIG_ERRORS.has(name) || error.statusCode === 401 || error.statusCode === 403) return "config";
  return "other";
}

export async function sendWithResend(mail: ContactMail): Promise<SendResult> {
  const resend = new Resend(mail.apiKey);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      resend.emails.send({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        attachments: mail.attachments,
      }),
      timeout,
    ]);
    if (result === "timeout") return { ok: false, failure: "timeout" };
    if (result.error) return { ok: false, failure: classifyResendError(result.error) };
    return { ok: true };
  } catch {
    return { ok: false, failure: "other" };
  } finally {
    clearTimeout(timer);
  }
}
