// タブを移動しても接続が切れないようにするための、このページ読み込み限りの控え。
//
// 画面 (/ ・/after ・/tenmatsu ・/senketsu) はそれぞれ別のルートなので、タブを切り替えると
// 画面は unmount され、接続の状態が初期値に戻る。そのたびに「接続する」を
// 押し直すのは手間なので、続きから始められる分だけをモジュール変数に控えておく。
//
// ★控えは**書類の種類ごと**に持つ。接続・一覧・進捗が混ざると、
//   専決決裁書のタブに顛末書の一覧が出てしまう。トークンだけは同じサーバーのものなので共有する。
//
// ★保存はしない。ブラウザを再読み込みすると消える (このファイルが読み直されるため)。
//   そのため「マウント時にローカルサーバーへ触らない」原則は崩れない —
//   控えが埋まっているのは、この読み込みの中で一度は「接続する」を押したときだけで、
//   新しく開いたタブ・再読み込みの直後は必ず未接続から始まる。
//
// ★ここに置くのは「戻ってきたときに続きから始めるために要るもの」だけにする。
//   下書き (トークンの入力欄)・一時的な失敗の文言・開いているプレビューは置かない。
import type { HealthPayload, ListItem, StatusPayload } from "@/lib/tenmatsu/client";
import type { DocKindId } from "@/lib/tenmatsu/kinds";
import type { ListFilter } from "@/lib/tenmatsu/list-view";

/** ローカルサーバーに繋がっているか */
export type Connection = "idle" | "checking" | "ok" | "unreachable";

export interface TenmatsuSession {
  /** 一度でも画面を開いたか (true なら下の値は前回の続き) */
  hydrated: boolean;
  token: string | null;
  /** トークンの入れ直しを促している最中か */
  editingToken: boolean;
  connection: Connection;
  health: HealthPayload | null;
  connectionError: string | null;
  items: ListItem[];
  /** この読み込みでサーバーから取り直したか */
  listFresh: boolean;
  /** 「一覧を消去」の直後か (自動の取り直しを止めたままにする) */
  cleared: boolean;
  /** この画面で印を変えた行 (完了になっても読み直すまでは隠さない) */
  recentNos: ReadonlySet<string>;
  /** 一覧の見せ方。タブを移動して戻ったときに元の見え方に戻らないよう控える */
  showCompleted: boolean;
  listFilter: ListFilter;
  status: StatusPayload | null;
  /** 取得の進捗を追っている最中か。戻ってきたら追い直す */
  polling: boolean;
  runObserved: boolean;
  storedMaxPerRun: number | null;
  maxInput: string;
}

const initialSession = (token: string | null): TenmatsuSession => ({
  hydrated: false,
  token,
  editingToken: false,
  connection: "idle",
  health: null,
  connectionError: null,
  items: [],
  listFresh: false,
  cleared: false,
  recentNos: new Set(),
  showCompleted: false,
  listFilter: "all",
  status: null,
  polling: false,
  runObserved: false,
  storedMaxPerRun: null,
  maxInput: "",
});

/**
 * 種類ごとの控え。**接続・一覧・進捗は種類で分ける**
 * (2つのタブを行き来しても、別の種類の一覧が出ないように)。
 * トークンだけは同じサーバーのものなので共有する。
 */
const sessions = new Map<DocKindId, TenmatsuSession>();

/** その種類の控え。同じ種類には毎回同じオブジェクトを返す */
export function getSession(kind: DocKindId): TenmatsuSession {
  const found = sessions.get(kind);
  if (found) return found;
  // 別のタブで登録済みならトークンを引き継ぐ (登録し直さずに使えるように)
  const shared = [...sessions.values()].find((s) => s.token !== null)?.token ?? null;
  const created = initialSession(shared);
  sessions.set(kind, created);
  return created;
}

/** 画面の今の状態を控える (毎レンダーの最後に呼ぶ) */
export function keepSession(kind: DocKindId, next: Omit<TenmatsuSession, "hydrated">): void {
  Object.assign(getSession(kind), next, { hydrated: true });
}

/** トークンの登録・削除を全部の種類の控えに反映する */
export function shareToken(token: string | null): void {
  for (const session of sessions.values()) session.token = token;
}

/** テスト用。控えを初期状態に戻す (種類を省くと全部) */
export function resetSessions(kind?: DocKindId): void {
  if (kind) sessions.delete(kind);
  else sessions.clear();
}
