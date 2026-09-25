import "server-only";
import { NextResponse } from "next/server";
import type { AuthConfig } from "@/lib/account/config";
import { sessionOf } from "@/lib/account/current";
import { BROKEN_TEXT, UNAUTHORIZED_TEXT, UNAVAILABLE_TEXT } from "@/lib/account/gate";
import { StoreUnavailableError, createMemoryKv } from "@/lib/account/kv";
import { sessionRevoked } from "@/lib/account/record";
import { accountStoreFor, currentAuthConfig, kvFor } from "@/lib/account/runtime";
import { type CredentialBinding, LOCAL_SUBJECT } from "./credential";
import { type CredentialStateStore, createCredentialStateStore } from "./credential-state";

/**
 * 楽楽精算の登録を使う口（ログイン・登録）で、「誰のものか」を決める（2026-09-25）。
 *
 * ★requireSignedIn は署名と期限しか見ない。登録を開く・楽楽精算へログインする前には、
 *   アカウントを置き場所で読み直す（止めた・ほかの端末でログインした・仮のパスワードの人は断る）。
 * ★手元でアカウントを使わないとき（off）は、持ち主を "local" にし、状態はメモリに置く。
 */
export type Subject =
  | {
      ok: true;
      binding: CredentialBinding;
      states: CredentialStateStore;
      /** Folio のパスワードのハッシュ（登録のとき、同じものが入っていないかを見る。手元の off では null） */
      folioHash: string | null;
    }
  | { ok: false; response: NextResponse<never> };

const text = (status: number, body: string) =>
  new NextResponse(body, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  }) as NextResponse<never>;

let localStates: CredentialStateStore | null = null;

export async function resolveSubject(request: Request, config: AuthConfig = currentAuthConfig()): Promise<Subject> {
  if (config.kind === "off") {
    localStates ??= createCredentialStateStore(createMemoryKv());
    return { ok: true, binding: { folioId: LOCAL_SUBJECT, createdAt: 0 }, states: localStates, folioHash: null };
  }
  if (config.kind === "broken") return { ok: false, response: text(503, BROKEN_TEXT) };
  const session = sessionOf(request, config);
  if (session.kind !== "account" || session.claims.mc === 1) return { ok: false, response: text(401, UNAUTHORIZED_TEXT) };
  try {
    const record = await accountStoreFor(config).get(session.claims.u);
    if (!record || record.mustChange || sessionRevoked(record, session.claims.sv)) {
      return { ok: false, response: text(401, UNAUTHORIZED_TEXT) };
    }
    return {
      ok: true,
      binding: { folioId: record.id, createdAt: record.createdAt },
      states: createCredentialStateStore(kvFor(config)),
      folioHash: record.hash,
    };
  } catch (e) {
    if (e instanceof StoreUnavailableError) return { ok: false, response: text(503, UNAVAILABLE_TEXT) };
    throw e;
  }
}

/** 封じた楽楽精算のログイン状態の持ち主（署名だけで分かる分。取得の口で使う） */
export function sessionSubjectOf(signedId: string | null): string {
  return signedId ?? LOCAL_SUBJECT;
}

/** テスト用 */
export function resetLocalCredentialStates(): void {
  localStates = null;
}
