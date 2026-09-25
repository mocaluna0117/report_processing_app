/**
 * 楽楽精算のIDとパスワードの登録（ブラウザ側。2026-09-25 の利用者の決定）。
 *
 * ★控えは**このPCのこのブラウザの IndexedDB**に、Folio のアカウントごとに置く（lib/tenmatsu/store.ts）。
 *   中身は Folio のサーバーの鍵で暗号にしたもので、ブラウザの中だけでは読めない。平文のIDとパスワードは置かない。
 * ★登録は本人だけが自分の分を入れる（アカウントの画面の「楽楽精算のIDとパスワード」）。
 * ★ログインは「取得」「部門を読み込む」「画面の下見」を押したときだけ（画面を開いただけではしない）。
 *   1回でも失敗したら、入れ直すまで自動ではログインしない（サーバーが決める。lib/rakuraku/credential-state.ts）。
 */
import { readSignedInCookie } from "@/lib/account/use-signed-in";
import {
  type StoredRakurakuCredential,
  clearRakurakuCredential,
  isStoredRakurakuCredential,
  loadRakurakuCredential,
  saveRakurakuCredential,
} from "@/lib/tenmatsu/store";
import { type RakurakuApi, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";

export type { StoredRakurakuCredential } from "@/lib/tenmatsu/store";

/** 手元でアカウントを使わないとき（off）の持ち主（サーバーの LOCAL_SUBJECT と同じ） */
export const LOCAL_OWNER = "local";

/** 控えの持ち主（いまログインしている Folio のアカウント）。表示用の印から読む */
export function credentialOwner(): string {
  return readSignedInCookie()?.id ?? LOCAL_OWNER;
}

/** サーバーが持つ「自動でログインしてよいか」の状態（秘密は入らない） */
export interface CredentialServerState {
  ver: string | null;
  failures: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastFailReason: string | null;
  busy: boolean;
}

/**
 * 画面に出す登録の状態。
 * - checking: 読んでいる
 * - none: このPCに登録が無い
 * - ready: 使える（取得のときに自動でログインする）
 * - rejected: 前回ログインできなかった（入れ直すまで自動ではログインしない）
 * - stale: このPCの登録は古い（ほかの画面で入れ直した・消した）
 */
export type CredentialView = "checking" | "none" | "ready" | "rejected" | "stale";

export function credentialView(input: {
  loaded: boolean;
  stored: StoredRakurakuCredential | null;
  server: CredentialServerState | null;
}): CredentialView {
  if (!input.loaded) return "checking";
  if (!input.stored) return "none";
  // サーバーの状態を読めなかったときは「使える」として出す（決めるのはサーバー。押せば理由が返る）
  if (!input.server) return "ready";
  if (input.server.ver !== input.stored.ver) return "stale";
  return input.server.failures > 0 ? "rejected" : "ready";
}

export const CREDENTIAL_TEXT: Record<Exclude<CredentialView, "checking">, string> = {
  none: "このPCには、楽楽精算のIDとパスワードが登録されていません。",
  ready: "登録済みです。取得のときに Folio が自動でログインします。",
  rejected:
    "前回、登録したIDとパスワードで楽楽精算にログインできませんでした。楽楽精算のアカウントがロックされないよう、入れ直すまで自動ではログインしません。",
  stale: "このPCの登録は使えなくなっています（ほかの画面で入れ直したか、消しました）。入れ直してください。",
};

export function isCredentialState(value: unknown): value is CredentialServerState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.ver === null || typeof v.ver === "string") && typeof v.failures === "number";
}

export async function loadCredential(owner: string = credentialOwner()): Promise<StoredRakurakuCredential | null> {
  return await loadRakurakuCredential(owner).catch(() => null);
}

/** サーバーの状態。読めなければ null（画面は「使える」として出す） */
export async function fetchCredentialState(fetchImpl: typeof fetch = fetch): Promise<CredentialServerState | null> {
  try {
    const res = await fetchImpl("/api/rakuraku/credential", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; state?: unknown };
    if (body.ok !== true || !isCredentialState(body.state)) return null;
    const s = body.state as CredentialServerState;
    return {
      ver: s.ver,
      failures: s.failures,
      lastOkAt: typeof s.lastOkAt === "number" ? s.lastOkAt : null,
      lastFailAt: typeof s.lastFailAt === "number" ? s.lastFailAt : null,
      lastFailReason: typeof s.lastFailReason === "string" ? s.lastFailReason : null,
      busy: s.busy === true,
    };
  } catch {
    return null;
  }
}

export interface SavedSession {
  sessionToken: string;
  expiresAt: number | null;
  viewTab: boolean | null;
}

export type SaveCredentialResult =
  | { ok: true; stored: StoredRakurakuCredential; session: SavedSession }
  | { ok: false; code: string; message: string };

const FAILED_TO_REACH = "Folio のサーバーに届きませんでした。インターネットの接続を確かめて、もう一度押してください";

/**
 * 「ログインできるか確かめて保存」。サーバーが1回だけログインしてみて、できたときだけ控えを返す。
 * ★パスワードは送るだけで、ここにもブラウザにも残さない（残るのは暗号にした控えだけ）。
 */
export async function verifyAndSaveCredential(
  input: { userId: string; password: string },
  owner: string = credentialOwner(),
  fetchImpl: typeof fetch = fetch,
): Promise<SaveCredentialResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/rakuraku/credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: input.userId, password: input.password }),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, code: "NETWORK", message: FAILED_TO_REACH };
  }
  if (res.status === 401) {
    return { ok: false, code: "UNAUTHORIZED", message: "Folio へのログインが切れました。画面を読み込み直して、Folio にログインし直してください" };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return { ok: false, code: "INTERNAL", message: "Folio のサーバーからの応答を読めませんでした" };
  if (body.ok !== true) {
    return { ok: false, code: typeof body.code === "string" ? body.code : "INTERNAL", message: typeof body.message === "string" ? body.message : "登録できませんでした" };
  }
  const stored = { sealed: body.credential, ver: body.ver, idHint: body.idHint, savedAt: body.savedAt };
  if (!isStoredRakurakuCredential(stored) || typeof body.sessionToken !== "string") {
    return { ok: false, code: "INTERNAL", message: "Folio のサーバーからの応答を読めませんでした" };
  }
  try {
    await saveRakurakuCredential(owner, stored);
  } catch {
    return { ok: false, code: "STORAGE", message: "このPCのブラウザに保存できませんでした（ブラウザの保存が止められている可能性があります）" };
  }
  return {
    ok: true,
    stored,
    session: {
      sessionToken: body.sessionToken,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
      viewTab: typeof body.viewTab === "boolean" ? body.viewTab : null,
    },
  };
}

/** 登録を消す（サーバーの版を無くし、このPCの控えも消す） */
export async function deleteCredential(
  owner: string = credentialOwner(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl("/api/rakuraku/credential", { method: "DELETE", cache: "no-store", credentials: "same-origin" });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (!res.ok || body?.ok !== true) return { ok: false, message: body?.message ?? "登録を消せませんでした" };
  } catch {
    return { ok: false, message: FAILED_TO_REACH };
  }
  await clearRakurakuCredential(owner).catch(() => undefined);
  return { ok: true };
}

/** 登録した控えで楽楽精算にログインする（押したときだけ呼ぶ。★やり直さない） */
export async function loginWithStoredCredential(
  api: RakurakuApi,
  owner: string = credentialOwner(),
): Promise<SavedSession> {
  const stored = await loadCredential(owner);
  if (!stored) throw new RakurakuApiError("CREDENTIAL_MISSING", `${CREDENTIAL_TEXT.none}アカウントの画面で登録してください`);
  return await api.login(stored.sealed);
}
