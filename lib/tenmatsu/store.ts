"use client";

// 顛末書タブの保存 (IndexedDB の meta ストア)。置くのは2つだけ:
//   1. ローカルサーバーのトークン (1回登録すれば次回から入力不要)
//   2. 取得済み一覧のキャッシュ (サーバーへ繋ぐ前でも前回の内容を出せるように)
// どちらもこの端末のこのブラウザの中だけに置く。folio のサーバー (Vercel) へは送らない。
// 一覧には伝票No.とファイル名が入るので、「一覧を消去」で消せるようにしている。
// PDFの実体はここには入れない (PCの保存先フォルダにあり、見るときだけ取りに行く)。
import {
  META_TENMATSU_LIST,
  SETTING_KEY_TENMATSU_TOKEN,
  STORE_META,
  deleteMeta,
  loadMeta,
  request,
  saveMeta,
  withStore,
} from "@/lib/storage";
import { isListItemLike, type ListItem } from "@/lib/tenmatsu/client";

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

/** 前回サーバーから取った一覧 (形の合わない記録は捨てる) */
export async function loadCachedList(): Promise<ListItem[]> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(META_TENMATSU_LIST)));
  return Array.isArray(raw) ? raw.filter(isListItemLike) : [];
}

/**
 * サーバーから取った一覧で置き換える。
 * ペアリングや受付一覧 (savePairs / saveAfterCases) と違い、空配列でもそのまま保存する。
 * 0件はサーバー側の正しい状態であって「まだ復元できていない」ではないため。
 * そのかわり、呼ぶのは /list の応答を受けた直後だけにすること。
 */
export async function saveCachedList(items: ListItem[]): Promise<void> {
  await saveMeta(META_TENMATSU_LIST, items);
}

/** 一覧のキャッシュだけを消す (「一覧を消去」ボタン。PCのPDFもトークンも消さない) */
export async function clearCachedList(): Promise<void> {
  await deleteMeta(META_TENMATSU_LIST);
}

/** この画面の保存データが残っているか (消去の導線を出すため) */
export async function hasTenmatsuData(): Promise<boolean> {
  const [token, items] = await Promise.all([loadToken(), loadCachedList()]);
  return token !== null || items.length > 0;
}
