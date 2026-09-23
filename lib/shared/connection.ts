"use client";

/**
 * 共有フォルダー（Box Drive などで見えるフォルダー）とのつながりを、**Folio 全体で1つだけ**持つ。
 *
 * ★ヘッダーのボタン・アフターの欄・定期点検・顛末書が同じつながりを使う（画面ごとにつなぎ直さない）。
 *   状態の共有は lib/help-dialog.ts・lib/tenmatsu/local/session.ts と同じ（モジュールの状態＋listener の Set）。
 * ★許可を尋ねる（requestPermission）のは**利用者がボタンを押した処理の中だけ**（choose / connect）。
 *   読み込み直後は尋ねずに今の許可を見て、生きていればそのままつなぐ。
 * ★自動で同期するのは、共有データを使う画面（定期点検・アフター・顛末書）が開いているときだけ
 *   （wantSharedSync を呼んだ画面）。専決決裁書・捺印決裁書では、ボタンを押さない限り同期しない。
 * ★初回の書き出しと顧客ファイルの入れ替えは、自動の同期では許さない（ボタンで確かめてから）。
 * 判断と文言は lib/shared/status.ts、読み書きは lib/shared/folder.ts と lib/shared/sync.ts。
 */
import type { CustomerSource } from "@/lib/after/types";
import { ledgerPutText, markOf, supersededFiles } from "@/lib/shared/customer-files";
import { SharedFolder, sharedErrorText } from "@/lib/shared/folder";
import type { SharedFolderState } from "@/lib/shared/status";
import {
  clearSharedFolder,
  loadDeviceId,
  loadLastSync,
  loadSeenCustomerFiles,
  loadSharedFolderHandle,
  saveSeenCustomerFiles,
  saveSharedFolderHandle,
} from "@/lib/shared/store";
import { type SyncOptions, type SyncReport, syncShared } from "@/lib/shared/sync";
import { isStorageAvailable } from "@/lib/storage";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import {
  type BrowserDirHandle,
  ensureFolderPermission,
  isFolderAccessSupported,
  pickFolder,
  queryFolderPermission,
} from "@/lib/tenmatsu/local/folder-handle";

/** 手直し・学習のあとに同期するまでの待ち（続けて直すたびに書かないため） */
export const SYNC_DEBOUNCE_MS = 1_500;
/**
 * 画面を開いたときに同期し直さない間隔。
 * ★タブを行き来するたびに Box を読みに行かないため。読み込み直した直後は間隔を見ずに同期する。
 */
export const SYNC_ON_OPEN_FRESH_MS = 60_000;

export interface SharedConnection {
  /** 前回の登録を読み終えたか（サーバーで描いた直後は false。ヘッダーは「共有フォルダー」とだけ出す） */
  known: boolean;
  state: SharedFolderState;
  folderName: string | null;
  lastSync: number | null;
  syncing: boolean;
  /** すでに文面になっている失敗（sharedErrorText を通したもの） */
  error: string | null;
  report: SyncReport | null;
}

type AllowOptions = Pick<SyncOptions, "allowFirstWrite" | "allowLedgerReplace">;

/** 外とのやり取り（テストで差し替える） */
export interface ConnectionDeps {
  supported: () => boolean;
  storageAvailable: () => boolean;
  loadHandle: () => Promise<BrowserDirHandle | null>;
  saveHandle: (handle: BrowserDirHandle) => Promise<void>;
  clearHandle: () => Promise<void>;
  loadLastSync: () => Promise<number | null>;
  queryPermission: (handle: BrowserDirHandle) => Promise<PermissionState>;
  /** ★ボタンを押した処理の中からだけ呼ぶ */
  ensurePermission: (handle: BrowserDirHandle) => Promise<void>;
  pick: () => Promise<BrowserDirHandle | null>;
  /** フォルダーを開いて、読み書きできるか確かめる */
  open: (handle: BrowserDirHandle) => Promise<SharedFolder>;
  sync: (folder: SharedFolder, allow: AllowOptions) => Promise<SyncReport>;
  now: () => number;
}

const DEFAULT_DEPS: ConnectionDeps = {
  supported: isFolderAccessSupported,
  storageAvailable: isStorageAvailable,
  loadHandle: loadSharedFolderHandle,
  saveHandle: saveSharedFolderHandle,
  clearHandle: clearSharedFolder,
  loadLastSync,
  queryPermission: queryFolderPermission,
  ensurePermission: ensureFolderPermission,
  pick: () => pickFolder("shared"),
  open: async (handle) => {
    const folder = new SharedFolder(new FolderStore(handle), await loadDeviceId());
    await folder.probe();
    return folder;
  },
  sync: (folder, allow) => syncShared(folder, allow),
  now: () => Date.now(),
};

const INITIAL: SharedConnection = {
  known: false,
  state: "none",
  folderName: null,
  lastSync: null,
  syncing: false,
  error: null,
  report: null,
};

let deps: ConnectionDeps = DEFAULT_DEPS;
let snapshot: SharedConnection = INITIAL;
let handle: BrowserDirHandle | null = null;
let folder: SharedFolder | null = null;
let restoring: Promise<void> | null = null;
let busy = false;
/** 同期の途中で頼まれた同期（終わったらもう1回だけ回す。取りこぼすと直した分が出ていかない） */
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 共有データを使う画面がいくつ開いているか（0 なら自動では同期しない） */
let users = 0;
/** つなぎ直すたびに進める（古いつなぎ方の結果で上書きしないため） */
let generation = 0;
const listeners = new Set<(state: SharedConnection) => void>();
const syncedListeners = new Set<(report: SyncReport) => void | Promise<void>>();

function set(next: Partial<SharedConnection>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener(snapshot);
}

export function getSharedConnection(): SharedConnection {
  return snapshot;
}

export function subscribeSharedConnection(listener: (state: SharedConnection) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 同期でこの端末の保存が変わったあとに呼ばれる（画面の写しを読み直してもらう）。
 * ★どの画面から始めた同期でも呼ぶ（ヘッダーから同期しても、開いている画面が読み直す）。
 */
export function onSharedSynced(listener: (report: SyncReport) => void | Promise<void>): () => void {
  syncedListeners.add(listener);
  return () => syncedListeners.delete(listener);
}

/** 1回分の同期。フォルダーそのものが使えないときだけ state を error にする */
async function runSync(allow: AllowOptions): Promise<void> {
  const target = folder;
  if (!target || !deps.storageAvailable()) return;
  if (busy) {
    // ★ボタンで許した同期（初回の書き出しなど）は、ここで捨てずに押し直してもらう
    if (!allow.allowFirstWrite && !allow.allowLedgerReplace) again = true;
    return;
  }
  busy = true;
  set({ syncing: true });
  try {
    const report = await deps.sync(target, allow);
    const lastSync = await deps.loadLastSync();
    if (folder === target) set({ report, lastSync, error: null, state: "connected" });
    for (const listener of [...syncedListeners]) {
      try {
        await listener(report);
      } catch {
        // 画面の読み直しに失敗しても、同期そのものは済んでいる
      }
    }
  } catch (e) {
    if (folder === target) set({ state: "error", error: sharedErrorText(e) });
  } finally {
    busy = false;
    set({ syncing: false });
  }
  if (again) {
    again = false;
    await runSync({});
  }
}

/** 開いたフォルダーにつなぐ。askPermission は**ボタンを押した処理の中だけ** true */
async function open(dir: BrowserDirHandle, askPermission: boolean): Promise<boolean> {
  const mine = ++generation;
  folder = null;
  set({ state: "connecting", error: null });
  try {
    if (askPermission) await deps.ensurePermission(dir);
    const opened = await deps.open(dir);
    if (mine !== generation) return false;
    folder = opened;
    set({ state: "connected" });
    return true;
  } catch (e) {
    if (mine !== generation) return false;
    folder = null;
    set({ state: "error", error: sharedErrorText(e) });
    return false;
  }
}

/**
 * 前回選んだフォルダーを読み、許可がまだ生きていれば尋ねずにつなぐ。何度呼んでも1回だけ動く。
 * ★画面を描いたあと（useEffect の中）で呼ぶ。サーバーで描いた中身と食い違わないように。
 * ★つないだあと、共有データを使う画面が開いていれば同期する（読み込み直した直後なので間隔は見ない）。
 */
export function restoreSharedConnection(): Promise<void> {
  restoring ??= (async () => {
    if (!deps.supported()) {
      set({ known: true, state: "unsupported" });
      return;
    }
    let saved: BrowserDirHandle | null = null;
    let at: number | null = null;
    try {
      [saved, at] = await Promise.all([deps.loadHandle(), deps.loadLastSync()]);
    } catch (e) {
      set({ known: true, state: "none", error: sharedErrorText(e) });
      return;
    }
    if (!saved) {
      set({ known: true, state: "none", lastSync: at });
      return;
    }
    handle = saved;
    set({ known: true, state: "prompt", folderName: saved.name, lastSync: at });
    let permission: PermissionState = "prompt";
    try {
      permission = await deps.queryPermission(saved);
    } catch {
      // 尋ねられないときは「つなぐ」を押してもらう
    }
    if (permission !== "granted" || handle !== saved) return;
    if ((await open(saved, false)) && users > 0) await runSync({});
  })();
  return restoring;
}

/**
 * 共有データを使う画面が開いた（閉じるときは返り値を呼ぶ）。
 * つながっていて、前回の同期から間が空いていれば、相手の分を取り込みに行く。
 */
export function wantSharedSync(): () => void {
  users += 1;
  const { state, lastSync } = snapshot;
  if (state === "connected" && (lastSync === null || deps.now() - lastSync >= SYNC_ON_OPEN_FRESH_MS)) {
    void runSync({});
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
  };
}

/** フォルダーを選ぶ（利用者がボタンを押したとき）。つないだらすぐ同期する */
export async function chooseSharedFolder(): Promise<void> {
  set({ error: null });
  try {
    const picked = await deps.pick();
    if (!picked) return; // 選ぶのをやめた
    handle = picked;
    set({ folderName: picked.name, report: null });
    await deps.saveHandle(picked);
    if (await open(picked, true)) await runSync({});
  } catch (e) {
    folder = null;
    set({ state: "error", error: sharedErrorText(e) });
  }
}

/** 前回のフォルダーに、許可をもらってつなぐ（利用者がボタンを押したとき）。つないだらすぐ同期する */
export async function connectSharedFolder(): Promise<void> {
  if (handle && (await open(handle, true))) await runSync({});
}

/** いま同期する。初回の書き出しや、顧客ファイルの入れ替えを許すときだけ true を渡す */
export async function syncSharedNow(options: AllowOptions = {}): Promise<void> {
  await runSync(options);
}

/** 手直し・学習のあとに呼ぶ（まとめて少し後に同期する。つないでいなければ何もしない） */
export function scheduleSharedSync(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // ★初回の書き出しと顧客ファイルの入れ替えは、ここでは許さない（ボタンで確かめてから）
    void runSync({});
  }, SYNC_DEBOUNCE_MS);
}

/**
 * 手で取り込んだ顧客データのファイルを、共有フォルダーにも置く。
 * つないでいなければ何もしない（null）。置けたら画面に出す1行を返す。
 */
export async function putSharedCustomerFile(
  name: string,
  bytes: Uint8Array,
  source: CustomerSource,
): Promise<string | null> {
  const target = folder;
  if (!target) return null;
  try {
    // ★共有データのフォルダーへ置く（直下は業務のフォルダーだけにしておく）
    const dir = await target.ensureDataDir();
    await target.store.writeBytes([...dir, name], bytes);
    const seen = await loadSeenCustomerFiles();
    // ★丸ごと入れ替える取り込み元（助っ人クラウド）だけ、前の台帳を外す。
    //   放っておくと「同じ取り込み元が2つ」になって取り込みが止まる。
    //   点検保守台帳は月ごとの差分を分けて置くので外さない
    const stale = supersededFiles(seen, source, name);
    for (const old of stale) await target.store.remove([...dir, old]).catch(() => undefined);
    const next = { ...seen };
    for (const old of stale) delete next[old];
    const stat = await target.store.stat([...dir, name]);
    if (stat?.kind === "file") {
      // ★自分で置いたファイルは、次の同期で取り込み直さなくてよい（もう取り込んである）
      next[name] = markOf({ name, size: stat.size, lastModified: stat.lastModified }, source, true);
    }
    await saveSeenCustomerFiles(next);
    return ledgerPutText(name, stale);
  } catch (e) {
    // ★置けなくても、この端末の取り込みは済んでいる。知らせるだけ
    return `共有フォルダーに「${name}」を置けませんでした（${sharedErrorText(e)}）。あとで「共有フォルダーと同期」を押すか、手でコピーしてください`;
  }
}

/** 登録を消す（★フォルダーの中のファイルは消さない） */
export async function forgetSharedFolder(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  generation += 1;
  folder = null;
  handle = null;
  set({
    state: deps.supported() ? "none" : "unsupported",
    folderName: null,
    report: null,
    lastSync: null,
    error: null,
  });
  try {
    await deps.clearHandle();
  } catch (e) {
    set({
      error: `共有フォルダーの登録を消せませんでした (${e instanceof Error ? e.message : String(e)})`,
    });
  }
}

/** テスト用: 状態を最初に戻し、外とのやり取りを差し替える */
export function resetSharedConnectionForTests(overrides: Partial<ConnectionDeps> = {}): void {
  if (timer) clearTimeout(timer);
  deps = { ...DEFAULT_DEPS, ...overrides };
  snapshot = INITIAL;
  handle = null;
  folder = null;
  restoring = null;
  busy = false;
  again = false;
  timer = null;
  users = 0;
  generation = 0;
  listeners.clear();
  syncedListeners.clear();
}
