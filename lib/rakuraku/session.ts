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
const TAG_BYTES = 16;
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
  /**
   * ログインしたときに「閲覧」タブがあったか（lib/rakuraku/tabs.ts）。
   * ★これで一覧の経路を最初から選べるので、閲覧側を試して失敗する1回が要らなくなる。
   *   無い（undefined）＝古い札。今までどおり閲覧 → ワークフローの順に試す。
   */
  viewTab?: boolean;
  /** 期限 (epoch ミリ秒) */
  exp: number;
  /**
   * 持ち主（Folio のアカウントの ID。手元でアカウントを使わないときは "local"）。
   * ★ほかの人の Folio のログインで使わせない（2026-09-25）。これが無い古い札は切れた扱い
   */
  sub: string;
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
  input: {
    state: string;
    home: string;
    routes?: Partial<Record<KindId, RememberedRoute>>;
    viewTab?: boolean;
    exp?: number;
    sub: string;
  },
  ttlMs = DEFAULT_TTL_MS,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv, { authTagLength: TAG_BYTES });
  const payload: SessionPayload = {
    state: input.state,
    home: input.home,
    ...(input.routes && Object.keys(input.routes).length > 0 ? { routes: input.routes } : {}),
    ...(input.viewTab === undefined ? {} : { viewTab: input.viewTab }),
    exp: input.exp ?? Date.now() + ttlMs,
    sub: input.sub,
  };
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  // iv . 認証タグ . 本体
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

/**
 * クッキーだけ新しくして封じ直す。
 * ★期限（exp）・覚えた経路（routes）・タブの判定（viewTab）は前のまま引き継ぐ。
 * 部門を読むだけの呼び出しで期限を延ばしたり、覚えた分を落としたりしないため。
 */
export function reseal(
  session: SessionPayload,
  state: string,
  routes: Partial<Record<KindId, RememberedRoute>> | undefined = session.routes,
): string {
  return seal({
    state,
    home: session.home,
    routes,
    viewTab: session.viewTab,
    exp: session.exp,
    sub: session.sub,
  });
}

/**
 * 開く。sub を渡すと、持ち主が違う札（ほかの人の Folio のログインで作られたもの・古い札）を断る。
 */
export function unseal(token: string, sub?: string): SessionPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SessionError("セッションの形が不正です");
  let json: string;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64url"));
    if (tag.length !== TAG_BYTES) throw new SessionError("セッションの形が不正です");
    const decipher = createDecipheriv(ALGORITHM, key(), iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof SessionError) throw e;
    // 中身を見せない (改ざんの手がかりを与えない)
    throw new SessionError("楽楽精算のログイン状態を読めませんでした");
  }
  const payload = JSON.parse(json) as SessionPayload;
  if (
    typeof payload.state !== "string" ||
    typeof payload.home !== "string" ||
    typeof payload.exp !== "number" ||
    (payload.viewTab !== undefined && typeof payload.viewTab !== "boolean") ||
    (payload.routes !== undefined && !isRouteMap(payload.routes)) ||
    (payload.sub !== undefined && typeof payload.sub !== "string")
  ) {
    throw new SessionError("セッションの中身が不正です");
  }
  if (payload.exp < Date.now()) {
    throw new SessionError("楽楽精算のログインの期限が切れています", "expired");
  }
  if (sub !== undefined && payload.sub !== sub) {
    throw new SessionError("楽楽精算のログインが切れています");
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
