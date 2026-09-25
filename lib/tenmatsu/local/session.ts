/**
 * 新しい方式の「このページ読み込み限りの控え」。タブを移動して戻ってきても続きから使えるようにする。
 *
 * ★楽楽精算のIDとパスワードはここには無い（2026-09-25 から、アカウントの画面で登録した暗号の控えを
 *   Folio のサーバーへ渡してログインする。lib/rakuraku-credential.ts）。
 * ★ログインは ensureSession だけが行う。タブの中で同時に何か所から呼ばれても1回にまとめる。
 * ★封じたログイン状態（sessionToken。中身は暗号化済み）と部門の選択肢だけは、
 *   **このタブの sessionStorage** にも置く（利用者の決定 2026-09-14）。再読み込みしても
 *   ログインしたまま使え、タブやブラウザを閉じれば消える。期限（8時間）を過ぎた分は戻さない。
 * ★取得そのものは lib/tenmatsu/local/client.ts が持っているので、画面を離れても止まらない
 *   （ブラウザのタブを閉じると止まる）。
 */
import type { DepartmentOption, RouteId } from "@/lib/rakuraku/protocol";
import type { ListItem, RunLogLine, StatusPayload } from "@/lib/tenmatsu/client";
import type { DocKindId } from "@/lib/tenmatsu/kinds";
import type { ListFilter, ListSort } from "@/lib/tenmatsu/list-view";
import type { LocalFolderClient } from "./client";
import type { BrowserDirHandle } from "./folder-handle";

// ---------------------------------------------------------------------------
// 楽楽精算のログイン（種類で分けない。同じアカウント）
// ---------------------------------------------------------------------------

let sessionToken: string | null = null;
/** 進んでいるログイン（タブで1つにまとめる） */
let loginPending: Promise<string> | null = null;
/** 最後のログインの失敗（画面の1行に出す。成功したら消える） */
let loginProblem: { code: string; message: string } | null = null;
/** sessionToken の期限（ミリ秒）。サーバーが教えてくれなかったら null（期限を見ない） */
let expiresAt: number | null = null;
/**
 * ログインしたアカウントに「閲覧」タブがあったか（サーバーがログインのときに見る）。
 * null＝分からない（古いサーバー）。一覧の経路をこれで決めるので、画面にも出す。
 */
let viewTab: boolean | null = null;
/** 種類ごとの部門の選択肢と選んだ部門（再読み込みのたびに楽楽精算へ読みに行かないため） */
let savedDepartments: Partial<Record<DocKindId, { departments: DepartmentOption[]; deptCode: string | null }>> = {};
/** このページ読み込みで、タブの控えを一度読んだか */
let restored = false;
const listeners = new Set<() => void>();

/** タブの控えのキー（sessionStorage。タブを閉じると消える） */
export const LOGIN_STORAGE_KEY = "folio:rakuraku:login";

interface LoginSnapshot {
  sessionToken: string;
  expiresAt: number | null;
  departments: typeof savedDepartments;
  viewTab?: boolean | null;
}

/** sessionStorage を使えないとき（サーバーで描くとき・ブラウザが禁止しているとき）は null */
function tabStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** いまのログイン状態をタブの控えに書く（ログインしていなければ消す）。★パスワードは書かない */
function persistLogin(): void {
  const store = tabStorage();
  if (!store) return;
  try {
    if (sessionToken === null) {
      store.removeItem(LOGIN_STORAGE_KEY);
      return;
    }
    const snapshot: LoginSnapshot = { sessionToken, expiresAt, departments: savedDepartments, viewTab };
    store.setItem(LOGIN_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 書けなくてもメモリでは使える（再読み込みでログインが切れるだけ）
  }
}

const isSnapshot = (value: unknown): value is LoginSnapshot => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionToken === "string" &&
    v.sessionToken.length > 0 &&
    (v.expiresAt === null || typeof v.expiresAt === "number") &&
    (v.departments === undefined || (typeof v.departments === "object" && v.departments !== null))
  );
};

/**
 * 再読み込みした直後に、このタブに残したログイン状態を戻す。戻せたら true。
 * ★画面を描いたあと（useEffect の中）で呼ぶ。サーバーで描いた HTML と食い違わないように。
 * 期限を過ぎていたら戻さずに消す。
 */
export function restoreLogin(now: number = Date.now()): boolean {
  if (restored) return sessionToken !== null;
  restored = true;
  if (sessionToken !== null) return true;
  const store = tabStorage();
  if (!store) return false;
  let snapshot: unknown;
  try {
    const raw = store.getItem(LOGIN_STORAGE_KEY);
    if (!raw) return false;
    snapshot = JSON.parse(raw);
  } catch {
    snapshot = null;
  }
  if (!isSnapshot(snapshot) || (snapshot.expiresAt !== null && snapshot.expiresAt <= now)) {
    try {
      store.removeItem(LOGIN_STORAGE_KEY);
    } catch {
      /* 消せなくても戻さないだけ */
    }
    return false;
  }
  sessionToken = snapshot.sessionToken;
  expiresAt = snapshot.expiresAt;
  savedDepartments = snapshot.departments ?? {};
  viewTab = typeof snapshot.viewTab === "boolean" ? snapshot.viewTab : null;
  notify();
  return true;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

/** ログインしたアカウントに「閲覧」タブがあったか。null＝分からない */
export function getViewTab(): boolean | null {
  return viewTab;
}

const notify = () => {
  for (const listener of listeners) listener();
};

/** いまログインしているところか */
export function isLoggingIn(): boolean {
  return loginPending !== null;
}

/** 最後のログインの失敗（無ければ null） */
export function getLoginProblem(): { code: string; message: string } | null {
  return loginProblem;
}

/** 失敗の表示を消す（アカウントの画面で入れ直したとき） */
export function clearLoginProblem(): void {
  if (loginProblem === null) return;
  loginProblem = null;
  notify();
}

/**
 * 楽楽精算にログインしている状態にする。ログインしていればそのまま返す。
 * ★呼ぶのは人が押したとき（取得・部門を読み込む・画面の下見）だけ。画面を開いただけでは呼ばない。
 * ★同時に何か所から呼ばれても、ログインは1回にまとめる。失敗してもやり直さない（呼ぶ側にそのまま返す）。
 */
export function ensureSession(
  login: () => Promise<{ sessionToken: string; expiresAt: number | null; viewTab: boolean | null }>,
): Promise<string> {
  if (sessionToken !== null) return Promise.resolve(sessionToken);
  if (loginPending) return loginPending;
  const pending = (async () => {
    try {
      const res = await login();
      loginProblem = null;
      setLogin({ sessionToken: res.sessionToken, expiresAt: res.expiresAt, viewTab: res.viewTab });
      return res.sessionToken;
    } catch (e) {
      loginProblem = {
        code: typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "INTERNAL",
        message: e instanceof Error ? e.message : "楽楽精算にログインできませんでした",
      };
      throw e;
    } finally {
      loginPending = null;
      notify();
    }
  })();
  loginPending = pending;
  notify();
  return pending;
}

/**
 * ログイン状態を変える。sessionToken を渡すとタブの控えも書き直す。
 * expiresAt を省いたときは今の期限を引き継ぐ（取得の途中で届く新しいトークンは期限が同じ）。
 */
export function setLogin(next: {
  sessionToken?: string | null;
  expiresAt?: number | null;
  viewTab?: boolean | null;
}): void {
  if (next.sessionToken !== undefined) {
    sessionToken = next.sessionToken;
    if (next.sessionToken === null) {
      expiresAt = null;
      savedDepartments = {};
      viewTab = null;
    }
  }
  if (next.viewTab !== undefined && sessionToken !== null) viewTab = next.viewTab;
  if (next.expiresAt !== undefined && sessionToken !== null) expiresAt = next.expiresAt;
  persistLogin();
  notify();
}

/** このタブのログイン状態を忘れる（Folio からログアウト・ログイン画面に来た・登録を入れ直した・消したとき） */
export function forgetLogin(): void {
  loginProblem = null;
  sessionToken = null;
  expiresAt = null;
  viewTab = null;
  savedDepartments = {};
  for (const session of sessions.values()) session.departments = null;
  persistLogin();
  notify();
}

/** 部門の選択肢と選んだ部門を、タブの控えに覚える（ログインしている間だけ） */
export function rememberDepartments(
  kind: DocKindId,
  departments: DepartmentOption[] | null,
  deptCode: string | null,
): void {
  if (sessionToken === null) return;
  const current = savedDepartments[kind];
  if (departments === null) {
    if (!current) return;
    delete savedDepartments[kind];
  } else {
    if (current && current.departments === departments && current.deptCode === deptCode) return;
    savedDepartments[kind] = { departments, deptCode };
  }
  persistLogin();
}

/** 再読み込みの前に覚えていた部門（無ければ null） */
export function restoredDepartments(
  kind: DocKindId,
): { departments: DepartmentOption[]; deptCode: string | null } | null {
  return savedDepartments[kind] ?? null;
}

/** ログインの状態が変わったら知らせる（別の種類のタブでログインしたときも画面を揃えるため） */
export function subscribeLogin(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// 種類ごとの控え
// ---------------------------------------------------------------------------

export type FolderConnection = "idle" | "checking" | "ok" | "error";

export interface FolderSession {
  hydrated: boolean;
  handle: BrowserDirHandle | null;
  client: LocalFolderClient | null;
  connection: FolderConnection;
  connectionError: string | null;
  items: ListItem[];
  listFresh: boolean;
  cleared: boolean;
  recentNos: ReadonlySet<string>;
  showCompleted: boolean;
  listFilter: ListFilter;
  /** 一覧の並べ替え (タブを行き来しても残す。再読み込みで既定に戻る) */
  listSort: ListSort;
  status: StatusPayload | null;
  runObserved: boolean;
  logLines: RunLogLine[];
  maxInput: string;
  /** 楽楽精算から読んだ部門の選択肢。null はまだ読んでいない、[] は部門の切り替えが無いアカウント */
  departments: DepartmentOption[] | null;
  deptCode: string | null;
  /**
   * 「部門を指定せずに取得する」を選んだか。
   * ★タブを行き来しても残すが、保存はしない（画面を読み込み直したら、普通に読みに行く）。
   */
  skipDepartment: boolean;
  /** 一覧の経路の固定（null なら自動で順に試す） */
  routePin: RouteId | null;
}

const initial = (): FolderSession => ({
  hydrated: false,
  handle: null,
  client: null,
  connection: "idle",
  connectionError: null,
  items: [],
  listFresh: false,
  cleared: false,
  recentNos: new Set(),
  showCompleted: false,
  listFilter: "all",
  listSort: "default",
  status: null,
  runObserved: false,
  logLines: [],
  maxInput: "",
  departments: null,
  deptCode: null,
  skipDepartment: false,
  routePin: null,
});

const sessions = new Map<DocKindId, FolderSession>();

export function getFolderSession(kind: DocKindId): FolderSession {
  const found = sessions.get(kind);
  if (found) return found;
  const created = initial();
  sessions.set(kind, created);
  return created;
}

export function keepFolderSession(kind: DocKindId, next: Omit<FolderSession, "hydrated">): void {
  Object.assign(getFolderSession(kind), next, { hydrated: true });
}

/** テスト用 */
export function resetFolderSessions(): void {
  sessions.clear();
  sessionToken = null;
  loginPending = null;
  loginProblem = null;
  expiresAt = null;
  viewTab = null;
  savedDepartments = {};
  restored = false;
  listeners.clear();
}
