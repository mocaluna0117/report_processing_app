import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type KindId, type RememberedRoute, isKindId, isRouteId } from "./protocol";

/**
 * 楽楽精算のログイン状態（クッキー）を、ブラウザに預けられる形に封じる。
 *
 * ★ 中身は楽楽精算のクッキーそのもの。持っている人はその利用者として操作できるので、
 *   **署名ではなく暗号化**して、Folio のサーバー以外では読めないようにする。
 * ★ ブラウザ側ではメモリにだけ置く（保存しない）。有効期限も入れる。
 */
const ALGORITHM = "aes-256-gcm";
/** ログイン状態の有効期限 (8時間)。ブラウザはこの期限を過ぎた控えを戻さない */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = SESSION_TTL_MS;

export interface SessionPayload {
  /** playwright の storageState をそのまま入れた文字列 */
  state: string;
  /** ログイン後に着いた画面。次回はここを開いて状態を確かめる */
  home: string;
  /**
   * 前に一覧を開けた経路（種類ごと）。メニューをたどって見つけた URL も一緒に覚える。
   * ★アカウントによって使える経路が違うので、2回目からは前に通った経路を先に試す。
   *   ブラウザから渡させず封じた中に入れるので、書き換えて別の場所へ行かせることはできない
   *   （画面から受けるのは経路の id だけ）。
   */
  routes?: Partial<Record<KindId, RememberedRoute>>;
  /** 期限 (epoch ミリ秒) */
  exp: number;
}

export type SessionErrorReason =
  /** 鍵が設定されていない（利用者ではなく設定の問題） */
  | "secret"
  /** 形が壊れている・別の鍵で封じられた */
  | "invalid"
  | "expired";

export class SessionError extends Error {
  constructor(
    message: string,
    readonly reason: SessionErrorReason = "invalid",
  ) {
    super(message);
    this.name = "SessionError";
  }
}

function key(): Buffer {
  const secret = process.env.RAKURAKU_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new SessionError("RAKURAKU_SESSION_SECRET が未設定か短すぎます (32文字以上)", "secret");
  }
  return createHash("sha256").update(secret).digest();
}

/**
 * 封じる。
 * ★ 呼び出しのたびにクッキーを新しくして封じ直すが、**期限は延ばさない**（`exp` を引き継ぐ）。
 *   使い続けるだけで永久に使える札にしないため。
 */
export function seal(
  input: { state: string; home: string; routes?: Partial<Record<KindId, RememberedRoute>>; exp?: number },
  ttlMs = DEFAULT_TTL_MS,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const payload: SessionPayload = {
    state: input.state,
    home: input.home,
    ...(input.routes && Object.keys(input.routes).length > 0 ? { routes: input.routes } : {}),
    exp: input.exp ?? Date.now() + ttlMs,
  };
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  // iv . 認証タグ . 本体
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

/**
 * クッキーだけ新しくして封じ直す。★期限（exp）と覚えた経路（routes）は前のまま引き継ぐ。
 * 部門を読むだけの呼び出しで期限を延ばしたり、覚えた経路を落としたりしないため。
 */
export function reseal(session: SessionPayload, state: string): string {
  return seal({ state, home: session.home, routes: session.routes, exp: session.exp });
}

export function unseal(token: string): SessionPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SessionError("セッションの形が不正です");
  let json: string;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof SessionError) throw e;
    // 中身を見せない (改ざんの手がかりを与えない)
    throw new SessionError("セッションを読めませんでした。ログインし直してください");
  }
  const payload = JSON.parse(json) as SessionPayload;
  if (
    typeof payload.state !== "string" ||
    typeof payload.home !== "string" ||
    typeof payload.exp !== "number" ||
    (payload.routes !== undefined && !isRouteMap(payload.routes))
  ) {
    throw new SessionError("セッションの中身が不正です");
  }
  if (payload.exp < Date.now()) {
    throw new SessionError("セッションの期限が切れています。ログインし直してください", "expired");
  }
  return payload;
}

/**
 * 覚えた経路の形か。
 * ※古い札は一覧の URL を `lists` に持っていたが、いまは読まずに捨てる（8時間で消える。
 *   どの種類も一覧のパスが分かっているので、覚えていなくても開ける）。
 */
function isRouteMap(value: unknown): value is Partial<Record<KindId, RememberedRoute>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => {
    if (!isKindId(k) || typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const route = v as { id?: unknown; url?: unknown };
    return isRouteId(route.id) && (route.url === undefined || typeof route.url === "string");
  });
}
