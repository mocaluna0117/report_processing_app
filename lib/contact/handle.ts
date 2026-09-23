/**
 * 問い合わせを受け取って送る（app/api/contact/route.ts から呼ぶ）。
 * 外とのやり取り（送信・回数の上限・時計）は引数で受け取り、テストで差し替える。
 *
 * ★受け取った中身は必ず sanitizeContactPayload を通す。写真は先頭のバイトで種類を確かめる。
 * ★写真のファイル名は使わない（名前にお客様の氏名が入っていることがある）。「写真1.jpg」などにする。
 * ★サーバーのログに中身を書かない。
 */
import {
  CONTACT_LIMITS,
  buildContactText,
  contactSubject,
  sanitizeContactPayload,
} from "@/lib/contact/form";
import { IMAGE_EXTENSION, imageKind } from "@/lib/contact/images";
import type { RateLimiter } from "@/lib/contact/rate-limit";
import type { ContactMail, SendFailure, SendResult } from "@/lib/contact/send";

export type ContactCode =
  | "OK"
  | "BAD_REQUEST"
  | "TOO_LARGE"
  | "NOT_CONFIGURED"
  | "TOO_MANY"
  | "SEND_FAILED";

export interface ContactResponse {
  ok: boolean;
  code: ContactCode;
  message: string;
}

export interface ContactEnv {
  apiKey?: string;
  to?: string;
  from?: string;
  /** VERCEL_GIT_COMMIT_SHA */
  commit?: string;
  /** VERCEL_ENV */
  environment?: string;
}

export interface ContactDeps {
  send: (mail: ContactMail) => Promise<SendResult>;
  limiter: RateLimiter;
  now: () => number;
}

export const DEFAULT_CONTACT_FROM = "Folio <onboarding@resend.dev>";
/** ざっくりしたメールアドレスの形（設定の書き間違いに気づくため） */
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const reply = (status: number, code: ContactCode, message: string) => ({
  status,
  body: { ok: code === "OK", code, message } satisfies ContactResponse,
});

const FAILURE_TEXT: Record<SendFailure, string> = {
  config: "送信の設定が合っていないため送れませんでした。「文面をコピー」で開発者へ直接知らせてください",
  quota: "今日はこれ以上送れません（1日100通まで）。明日もう一度送るか、「文面をコピー」で開発者へ直接知らせてください",
  rate: "送信が混み合っています。少し待ってからもう一度押してください",
  timeout: "送信の返事がありませんでした。少し待ってからもう一度押してください（届いていることもあります）",
  other: "送れませんでした。少し待ってからもう一度押すか、「文面をコピー」で開発者へ直接知らせてください",
};

export async function handleContact(
  form: FormData,
  env: ContactEnv,
  deps: ContactDeps,
): Promise<{ status: number; body: ContactResponse }> {
  const apiKey = env.apiKey?.trim();
  const to = env.to?.trim();
  if (!apiKey || !to || !ADDRESS.test(to)) {
    return reply(503, "NOT_CONFIGURED", "問い合わせの送信がまだ設定されていません。「文面をコピー」で開発者へ直接知らせてください");
  }

  const rawPayload = form.get("payload");
  let parsed: unknown = null;
  try {
    parsed = typeof rawPayload === "string" ? JSON.parse(rawPayload) : null;
  } catch {
    parsed = null;
  }
  const checked = sanitizeContactPayload(parsed);
  if (!checked.ok) return reply(400, "BAD_REQUEST", checked.message);

  const photos = form.getAll("photo").filter((v): v is File => typeof v !== "string");
  if (photos.length > CONTACT_LIMITS.photos) {
    return reply(400, "BAD_REQUEST", `写真は ${CONTACT_LIMITS.photos}枚までです`);
  }
  let total = 0;
  const attachments: ContactMail["attachments"] = [];
  for (const [i, photo] of photos.entries()) {
    total += photo.size;
    if (photo.size > CONTACT_LIMITS.photoBytes || total > CONTACT_LIMITS.totalBytes) {
      return reply(413, "TOO_LARGE", "写真が大きすぎます。枚数を減らしてください");
    }
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const kind = imageKind(bytes);
    if (!kind) return reply(400, "BAD_REQUEST", "写真として読めないファイルがあります（PNG・JPEG・WebP だけ付けられます）");
    attachments.push({ filename: `写真${i + 1}.${IMAGE_EXTENSION[kind]}`, content: Buffer.from(bytes) });
  }

  const now = deps.now();
  if (!deps.limiter.take(now)) {
    const wait = deps.limiter.waitSeconds(now);
    return reply(429, "TOO_MANY", `続けて送られたため、いったん止めています。${Math.max(1, Math.ceil(wait / 60))}分ほど待ってからもう一度押してください`);
  }

  const result = await deps.send({
    apiKey,
    from: env.from?.trim() || DEFAULT_CONTACT_FROM,
    to,
    subject: contactSubject(checked.payload),
    text: buildContactText(checked.payload, {
      version: env.commit?.trim() || null,
      environment: env.environment?.trim() || null,
      at: now,
      photos: attachments.length,
    }),
    attachments,
  });
  if (!result.ok) return reply(502, "SEND_FAILED", FAILURE_TEXT[result.failure]);
  return reply(200, "OK", "送りました。ありがとうございます");
}
