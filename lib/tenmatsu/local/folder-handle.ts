/**
 * 保存先フォルダーを選ぶ・使う許可をもらう（File System Access API）。
 *
 * ★使えるのは Windows / macOS の **Chrome と Edge** だけ（Safari・Firefox・スマートフォンでは使えない）。
 * ★許可を尋ねる（requestPermission）のは、**利用者がボタンを押した処理の中だけ**。
 *   読み込み直後に尋ねるとブラウザが断る。尋ねずに今の許可を見る（queryPermission）のはいつでもよい。
 */
import { type DirHandleLike, FolderError } from "./fs";

type PermissionMode = { mode: "readwrite" };
type PermissionState = "granted" | "denied" | "prompt";

/** ブラウザのフォルダーの参照（lib.dom の型に許可まわりが無いので、使う分だけ書く） */
export interface BrowserDirHandle extends DirHandleLike {
  queryPermission?(descriptor: PermissionMode): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionMode): Promise<PermissionState>;
}

interface PickerWindow {
  showDirectoryPicker?(options: { id?: string; mode?: "readwrite"; startIn?: string }): Promise<BrowserDirHandle>;
}

const READWRITE: PermissionMode = { mode: "readwrite" };

/** このブラウザでフォルダーを選べるか */
export function isFolderAccessSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as PickerWindow).showDirectoryPicker === "function";
}

export const FOLDER_UNSUPPORTED_TEXT =
  "このブラウザでは保存先フォルダーを使えません。Windows または macOS の Chrome か Edge で開いてください（Safari・Firefox・スマートフォンでは使えません）。";

/**
 * フォルダーを選んでもらう。やめたら null。
 * 前回の場所を**用途ごとに**覚えさせる（顛末書・専決決裁書・共有フォルダーで別の場所を選ぶため）。
 * `use` は覚えさせる用途の名前（顛末書系は種類のID、共有フォルダーは "shared"）。
 */
export async function pickFolder(use: string): Promise<BrowserDirHandle | null> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new FolderError("unknown", FOLDER_UNSUPPORTED_TEXT);
  try {
    return await picker.call(window, { id: `folio-${use}`, mode: "readwrite", startIn: "documents" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null; // 選ぶのをやめた
    if (e instanceof DOMException && e.name === "SecurityError") {
      throw new FolderError("permission", "このフォルダーは選べません（システムのフォルダーなど）。書類を置く普通のフォルダーを選んでください");
    }
    throw e;
  }
}

/** 尋ねずに、いまの許可を見る。わからなければ "prompt" */
export async function queryFolderPermission(handle: BrowserDirHandle): Promise<PermissionState> {
  try {
    return (await handle.queryPermission?.(READWRITE)) ?? "granted";
  } catch {
    return "prompt";
  }
}

/**
 * 読み書きの許可をもらう。★ボタンを押した処理の中から呼ぶこと。
 * 許可されなければ FolderError（permission）。
 */
export async function ensureFolderPermission(handle: BrowserDirHandle): Promise<void> {
  if ((await queryFolderPermission(handle)) === "granted") return;
  let state: PermissionState;
  try {
    state = (await handle.requestPermission?.(READWRITE)) ?? "granted";
  } catch (e) {
    throw new FolderError(
      "permission",
      `保存先フォルダーを使う許可をもらえませんでした（${e instanceof Error ? e.name : "原因不明"}）。もう一度「フォルダーにつなぐ」を押してください`,
    );
  }
  if (state !== "granted") {
    throw new FolderError("permission", "保存先フォルダーを使う許可がありません。「フォルダーにつなぐ」を押して「許可」を選んでください");
  }
}
