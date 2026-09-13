/**
 * 新しい方式の「このページ読み込み限りの控え」。タブを移動して戻ってきても続きから使えるようにする。
 *
 * ★**楽楽精算のパスワードと、封じたログイン状態（sessionToken）はここ（メモリ）にだけ置く。**
 *   保存しない。ブラウザを再読み込みすると消える。
 * ★取得そのものは lib/tenmatsu/local/client.ts が持っているので、画面を離れても止まらない
 *   （ブラウザのタブを閉じると止まる）。
 */
import type { DepartmentOption } from "@/lib/rakuraku/protocol";
import type { ListItem, RunLogLine, StatusPayload } from "@/lib/tenmatsu/client";
import type { DocKindId } from "@/lib/tenmatsu/kinds";
import type { ListFilter } from "@/lib/tenmatsu/list-view";
import type { LocalFolderClient } from "./client";
import type { BrowserDirHandle } from "./folder-handle";

// ---------------------------------------------------------------------------
// 楽楽精算のログイン（種類で分けない。同じアカウント）
// ---------------------------------------------------------------------------

let password: string | null = null;
let sessionToken: string | null = null;
const listeners = new Set<() => void>();

export function getPassword(): string | null {
  return password;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

const notify = () => {
  for (const listener of listeners) listener();
};

export function setLogin(next: { password?: string | null; sessionToken?: string | null }): void {
  if (next.password !== undefined) password = next.password;
  if (next.sessionToken !== undefined) sessionToken = next.sessionToken;
  notify();
}

/** パスワードとログイン状態を忘れる（「パスワードを忘れる」ボタン・ログインIDを変えたとき） */
export function forgetLogin(): void {
  password = null;
  sessionToken = null;
  for (const session of sessions.values()) session.departments = null;
  notify();
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
  status: StatusPayload | null;
  runObserved: boolean;
  logLines: RunLogLine[];
  maxInput: string;
  /** 楽楽精算から読んだ部門の選択肢。null はまだ読んでいない、[] は部門の切り替えが無いアカウント */
  departments: DepartmentOption[] | null;
  deptCode: string | null;
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
  status: null,
  runObserved: false,
  logLines: [],
  maxInput: "",
  departments: null,
  deptCode: null,
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
  password = null;
  sessionToken = null;
  listeners.clear();
}
