"use client";

// 共有フォルダーの設定をブラウザ（IndexedDB の meta ストア）に置く。
//
// ここに置くのは**設定だけ**:
//   1. 選んだ共有フォルダーの参照（場所への参照。中のファイルはコピーしない）
//   2. この端末の目印（乱数。★氏名・PC名・ログインIDは入れない）
//   3. 最後に同期できた日時
// ★顧客の個人情報はここに置かない（共有フォルダーの中のファイルと customers ストアにある）。
// ★「保存データを消去」（定期点検）では消えない。消すのは「共有フォルダーの登録を消す」だけ。
import {
  SETTING_KEY_SHARED_CUSTOMER_FILES,
  SETTING_KEY_SHARED_DEVICE_ID,
  SETTING_KEY_SHARED_FOLDER,
  SETTING_KEY_SHARED_LAST_SYNC,
  deleteMeta,
  loadMeta,
  saveMeta,
} from "@/lib/storage";
import { type SeenCustomerFiles, isSeenCustomerFiles } from "@/lib/shared/customer-files";
import type { BrowserDirHandle } from "@/lib/tenmatsu/local/folder-handle";

/** 前回選んだ共有フォルダー。選んでいなければ null */
export async function loadSharedFolderHandle(): Promise<BrowserDirHandle | null> {
  const raw = await loadMeta<unknown>(SETTING_KEY_SHARED_FOLDER);
  return raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "directory"
    ? (raw as BrowserDirHandle)
    : null;
}

export async function saveSharedFolderHandle(handle: BrowserDirHandle): Promise<void> {
  await saveMeta(SETTING_KEY_SHARED_FOLDER, handle);
}

/**
 * 共有フォルダーの登録を消す（「共有フォルダーの登録を消す」ボタン）。
 * ★フォルダーの中のファイルは消さない（相手の正本なので、この端末の都合で消してはいけない）。
 * ★最後に同期した日時も一緒に消す（次につないだときに古い日時を出さないため）。
 */
export async function clearSharedFolder(): Promise<void> {
  await deleteMeta(SETTING_KEY_SHARED_FOLDER);
  await deleteMeta(SETTING_KEY_SHARED_LAST_SYNC);
  // ★取り込んだ目印も消す（つなぎ直したら読み直す）。顧客データそのものは消さない
  await deleteMeta(SETTING_KEY_SHARED_CUSTOMER_FILES);
}

/**
 * この端末の目印を作る。
 * ★**乱数だけ**。氏名・PC名・ログインIDを混ぜない（共有フォルダーのファイルに書かれ、
 *   相手や Box の管理者からも見えるため）。
 */
export function newDeviceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // randomUUID が無いブラウザ向けの控え（目印なので、重ならなければよい）
  return `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** この端末の目印。無ければ作って覚える（同じ端末はずっと同じ目印を使う） */
export async function loadDeviceId(): Promise<string> {
  const raw = await loadMeta<unknown>(SETTING_KEY_SHARED_DEVICE_ID);
  if (typeof raw === "string" && raw !== "") return raw;
  const id = newDeviceId();
  await saveMeta(SETTING_KEY_SHARED_DEVICE_ID, id);
  return id;
}

/** 最後に同期できた日時。まだ一度も同期していなければ null */
export async function loadLastSync(): Promise<number | null> {
  const raw = await loadMeta<unknown>(SETTING_KEY_SHARED_LAST_SYNC);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export async function saveLastSync(at: number): Promise<void> {
  await saveMeta(SETTING_KEY_SHARED_LAST_SYNC, at);
}

/**
 * 共有フォルダーの顧客ファイルを取り込んだときの目印（名前 → 大きさと更新時刻）。
 * ★変わっていないファイルを取り込み直さないために持つ。顧客データそのものは customers ストアにある。
 */
export async function loadSeenCustomerFiles(): Promise<SeenCustomerFiles> {
  const raw = await loadMeta<unknown>(SETTING_KEY_SHARED_CUSTOMER_FILES);
  return isSeenCustomerFiles(raw) ? raw : {};
}

export async function saveSeenCustomerFiles(seen: SeenCustomerFiles): Promise<void> {
  if (Object.keys(seen).length === 0) {
    await deleteMeta(SETTING_KEY_SHARED_CUSTOMER_FILES);
    return;
  }
  await saveMeta(SETTING_KEY_SHARED_CUSTOMER_FILES, seen);
}
