"use client";

// 顛末書タブの保存 (IndexedDB の meta ストア)。置くもの:
//   1. ローカルサーバーのトークン (旧方式。1回登録すれば次回から入力不要)
//   2. 取得済み一覧のキャッシュ (つなぐ前でも前回の内容を出せるように。旧方式と新方式で別々)
//   3. 1回に取る件数 (次回も同じ件数から始められるように)
//   4. 取得の方法・保存先フォルダー・部門・楽楽精算のログインID (新方式)
// どれもこの端末のこのブラウザの中だけに置く。folio のサーバー (Vercel) へは送らない。
// 一覧には伝票№とファイル名が入るので、「一覧を消去」で消せるようにしている。
// PDFの実体はここには入れない (PCの保存先フォルダにあり、見るときだけ取りに行く)。
// ★楽楽精算のパスワードはここに置かない (メモリにだけ持つ。lib/tenmatsu/local/session.ts)。
import {
  META_NATSUIN_LIST,
  META_SENKETSU_LIST,
  META_TENMATSU_LIST,
  SETTING_KEY_NATSUIN_MAX_PER_RUN,
  SETTING_KEY_RAKURAKU_USER_ID,
  SETTING_KEY_SENKETSU_MAX_PER_RUN,
  SETTING_KEY_TENMATSU_MAX_PER_RUN,
  SETTING_KEY_TENMATSU_TOKEN,
  STORE_META,
  deleteMeta,
  loadMeta,
  request,
  saveMeta,
  withStore,
} from "@/lib/storage";
import { type RouteId, isRouteId } from "@/lib/rakuraku/protocol";
import { isListItemLike, type ListItem } from "@/lib/tenmatsu/client";
import type { DocKindId } from "@/lib/tenmatsu/kinds";

/** 取得の方法。local-server＝PCで動く Python のツール（旧）、folder＝このブラウザで取得して選んだフォルダーへ保存（新） */
export type TenmatsuSource = "local-server" | "folder";

/**
 * 種類ごとの保存キー。**トークンは共有**（同じサーバー・同じトークン）。
 * ★キーと種類の対応はここ1か所だけで結ぶ。画面が種類を取り違えると
 *   別の種類の一覧を上書きしてしまうので、引数に既定値は置かない。
 */
const KEYS: Record<
  DocKindId,
  { list: string; maxPerRun: string; source: string; folder: string; folderList: string; dept: string; pdfStats: string; route: string }
> = {
  tenmatsu: {
    list: META_TENMATSU_LIST,
    maxPerRun: SETTING_KEY_TENMATSU_MAX_PER_RUN,
    source: "tenmatsu:source",
    folder: "tenmatsu:folder",
    folderList: "tenmatsu:folderList",
    dept: "tenmatsu:dept",
    pdfStats: "tenmatsu:pdfStats",
    route: "tenmatsu:route",
  },
  senketsu: {
    list: META_SENKETSU_LIST,
    maxPerRun: SETTING_KEY_SENKETSU_MAX_PER_RUN,
    source: "senketsu:source",
    folder: "senketsu:folder",
    folderList: "senketsu:folderList",
    dept: "senketsu:dept",
    pdfStats: "senketsu:pdfStats",
    route: "senketsu:route",
  },
  natsuin: {
    list: META_NATSUIN_LIST,
    maxPerRun: SETTING_KEY_NATSUIN_MAX_PER_RUN,
    source: "natsuin:source",
    folder: "natsuin:folder",
    folderList: "natsuin:folderList",
    dept: "natsuin:dept",
    pdfStats: "natsuin:pdfStats",
    route: "natsuin:route",
  },
};

export async function loadToken(): Promise<string | null> {
  const raw = await loadMeta<unknown>(SETTING_KEY_TENMATSU_TOKEN);
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** 貼り付けられたトークンを保存する (使える文字かの検証は呼ぶ側で済ませておくこと) */
export async function saveToken(token: string): Promise<void> {
  await saveMeta(SETTING_KEY_TENMATSU_TOKEN, token);
}

/** トークンの登録を消す (「トークンの登録を消す」ボタン。一覧は残す) */
export async function clearToken(): Promise<void> {
  await deleteMeta(SETTING_KEY_TENMATSU_TOKEN);
}

const readList = async (key: string): Promise<ListItem[]> => {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(key)));
  return Array.isArray(raw) ? raw.filter(isListItemLike) : [];
};

/** 前回サーバーから取った一覧 (形の合わない記録は捨てる) */
export async function loadCachedList(kind: DocKindId): Promise<ListItem[]> {
  return await readList(KEYS[kind].list);
}

/**
 * サーバーから取った一覧で置き換える。
 * ペアリングや受付一覧 (savePairs / saveAfterCases) と違い、空配列でもそのまま保存する。
 * 0件はサーバー側の正しい状態であって「まだ復元できていない」ではないため。
 * そのかわり、呼ぶのは /list の応答を受けた直後だけにすること。
 */
export async function saveCachedList(kind: DocKindId, items: ListItem[]): Promise<void> {
  await saveMeta(KEYS[kind].list, items);
}

/** 一覧のキャッシュだけを消す (「一覧を消去」ボタン。PCのPDFもトークンも消さない) */
export async function clearCachedList(kind: DocKindId): Promise<void> {
  await deleteMeta(KEYS[kind].list);
}

/**
 * 1回に取る件数。整数でなければ null (＝サーバーの既定値を使う)。
 * 上下限に収まっているかはここでは見ない (サーバーごとに違うので使うときに丸める)。
 */
export async function loadMaxPerRun(kind: DocKindId): Promise<number | null> {
  const raw = await loadMeta<unknown>(KEYS[kind].maxPerRun);
  return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

export async function saveMaxPerRun(kind: DocKindId, value: number): Promise<void> {
  await saveMeta(KEYS[kind].maxPerRun, value);
}

/**
 * この画面の保存データが残っているか (消去の導線を出すため)。
 * 件数は設定なので数えない (件数だけ残っている状態で消去のボタンを出す意味はない)。
 */
export async function hasTenmatsuData(kind: DocKindId): Promise<boolean> {
  const [token, items] = await Promise.all([loadToken(), loadCachedList(kind)]);
  return token !== null || items.length > 0;
}

// ---------------------------------------------------------------------------
// 新しい方式（このブラウザで取得して、選んだフォルダーへ保存）
// ---------------------------------------------------------------------------

/**
 * 取得の方法。保存していなければ null。
 * ★既定の決め方は画面側（loadSource の結果が null のとき、旧方式のトークンがあれば旧方式）。
 */
export async function loadSource(kind: DocKindId): Promise<TenmatsuSource | null> {
  const raw = await loadMeta<unknown>(KEYS[kind].source);
  return raw === "local-server" || raw === "folder" ? raw : null;
}

export async function saveSource(kind: DocKindId, source: TenmatsuSource): Promise<void> {
  await saveMeta(KEYS[kind].source, source);
}

/** 保存しなかったときの取得の方法。旧方式のトークンを登録済みの人は旧方式のまま、そうでなければ新方式 */
export function defaultSource(hasToken: boolean): TenmatsuSource {
  return hasToken ? "local-server" : "folder";
}

/**
 * 選んだ保存先フォルダー（場所への参照）。無ければ null。
 * ★IndexedDB にはフォルダーの中身ではなく「場所への参照」だけが入る。使うたびにブラウザの許可が要る。
 */
export async function loadFolderHandle<T = unknown>(kind: DocKindId): Promise<T | null> {
  const raw = await loadMeta<unknown>(KEYS[kind].folder);
  return raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "directory" ? (raw as T) : null;
}

export async function saveFolderHandle(kind: DocKindId, handle: unknown): Promise<void> {
  await saveMeta(KEYS[kind].folder, handle);
}

/** 保存先フォルダーの登録を消す（フォルダーの中身は消さない） */
export async function clearFolderHandle(kind: DocKindId): Promise<void> {
  await deleteMeta(KEYS[kind].folder);
}

/** 新しい方式で前回読んだ一覧の写し（旧方式の一覧とは別に持つ） */
export async function loadFolderList(kind: DocKindId): Promise<ListItem[]> {
  return await readList(KEYS[kind].folderList);
}

export async function saveFolderList(kind: DocKindId, items: ListItem[]): Promise<void> {
  await saveMeta(KEYS[kind].folderList, items);
}

export async function clearFolderList(kind: DocKindId): Promise<void> {
  await deleteMeta(KEYS[kind].folderList);
}

export interface SavedDepartment {
  code: string;
  label: string;
}

/** 前回選んだ部門。形が合わなければ null */
export async function loadDept(kind: DocKindId): Promise<SavedDepartment | null> {
  const raw = await loadMeta<unknown>(KEYS[kind].dept);
  if (!raw || typeof raw !== "object") return null;
  const { code, label } = raw as Record<string, unknown>;
  return typeof code === "string" && code !== "" && typeof label === "string" ? { code, label } : null;
}

export async function saveDept(kind: DocKindId, dept: SavedDepartment): Promise<void> {
  await saveMeta(KEYS[kind].dept, { code: dept.code, label: dept.label });
}

/**
 * 一覧の経路の固定（画面の「一覧の経路」）。保存していなければ null＝自動で順に試す。
 * ★知らない値は無視する（古い保存データで、無い経路を固定したことにしない）。
 */
export async function loadRoutePin(kind: DocKindId): Promise<RouteId | null> {
  const raw = await loadMeta<unknown>(KEYS[kind].route);
  return isRouteId(raw) ? raw : null;
}

/** 経路の固定を保存する。null なら「自動」に戻す */
export async function saveRoutePin(kind: DocKindId, route: RouteId | null): Promise<void> {
  if (route === null) await deleteMeta(KEYS[kind].route);
  else await saveMeta(KEYS[kind].route, route);
}

/** 楽楽精算のログインID（種類で分けない。★パスワードは保存しない） */
export async function loadUserId(): Promise<string | null> {
  const raw = await loadMeta<unknown>(SETTING_KEY_RAKURAKU_USER_ID);
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

export async function saveUserId(userId: string): Promise<void> {
  await saveMeta(SETTING_KEY_RAKURAKU_USER_ID, userId);
}

export async function clearUserId(): Promise<void> {
  await deleteMeta(SETTING_KEY_RAKURAKU_USER_ID);
}

/** PDF のページ数の控え（キー → ページ数。読めなかったものは null） */
export async function loadPdfStats(kind: DocKindId): Promise<Record<string, number | null>> {
  const raw = await loadMeta<unknown>(KEYS[kind].pdfStats);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, v]) => v === null || (typeof v === "number" && Number.isInteger(v))),
  ) as Record<string, number | null>;
}

export async function savePdfStats(kind: DocKindId, stats: Record<string, number | null>): Promise<void> {
  await saveMeta(KEYS[kind].pdfStats, stats);
}

/** 新しい方式の保存データが残っているか（消去の導線を出すため） */
export async function hasFolderData(kind: DocKindId): Promise<boolean> {
  const [folder, items, userId] = await Promise.all([loadFolderHandle(kind), loadFolderList(kind), loadUserId()]);
  return folder !== null || items.length > 0 || userId !== null;
}
