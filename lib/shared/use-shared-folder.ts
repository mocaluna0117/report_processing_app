"use client";

// 共有フォルダーの欄の状態を持つ。判断と文言は lib/shared/status.ts、
// 読み書きは lib/shared/folder.ts と lib/shared/sync.ts にあるので、ここは薄く保つ。
//
// ★許可を尋ねる（requestPermission）のは**利用者がボタンを押した処理の中だけ**。
//   読み込み直後は尋ねずに今の許可を見て、生きていればそのままつなぐ（顛末書の画面と同じ）。
// ★同期は storage.canPersist（復元できた）まで走らせない。
import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomerSource } from "@/lib/after/types";
import { ledgerPutText, markOf, staleWrittenFiles } from "@/lib/shared/customer-files";
import type { SharedFolderState } from "@/lib/shared/status";
import { SharedFolder, sharedErrorText } from "@/lib/shared/folder";
import {
  clearSharedFolder,
  loadDeviceId,
  loadLastSync,
  loadSeenCustomerFiles,
  loadSharedFolderHandle,
  saveSeenCustomerFiles,
  saveSharedFolderHandle,
} from "@/lib/shared/store";
import { type SyncReport, syncShared } from "@/lib/shared/sync";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import {
  type BrowserDirHandle,
  ensureFolderPermission,
  isFolderAccessSupported,
  pickFolder,
  queryFolderPermission,
} from "@/lib/tenmatsu/local/folder-handle";

/** 手直し・学習のあとに同期するまでの待ち（続けて直すたびに書かないため） */
const SYNC_DEBOUNCE_MS = 1_500;

export interface SharedFolderHook {
  state: SharedFolderState;
  folderName: string | null;
  lastSync: number | null;
  syncing: boolean;
  error: string | null;
  report: SyncReport | null;
  /** つないでいるか（消去の確認文の出し分けに使う） */
  connected: boolean;
  /** 復元時に呼ぶ（usePersistence の restore から） */
  restore: () => Promise<void>;
  /** フォルダーを選ぶ（利用者がボタンを押したとき） */
  choose: () => Promise<void>;
  /** 前回のフォルダーに、許可をもらってつなぐ */
  connect: () => Promise<void>;
  /** いま同期する。初回の書き出しや、顧客ファイルの入れ替えを許すときだけ true を渡す */
  sync: (options?: { allowFirstWrite?: boolean; allowLedgerReplace?: boolean }) => Promise<void>;
  /** 手直し・学習のあとに呼ぶ（まとめて少し後に同期する） */
  scheduleSync: () => void;
  /**
   * 手で取り込んだ顧客データのファイルを、共有フォルダーにも置く。
   * つないでいなければ何もしない（null）。置けたら画面に出す1行を返す。
   */
  putCustomerFile: (
    name: string,
    bytes: Uint8Array,
    source: CustomerSource,
  ) => Promise<string | null>;
  /** 登録を消す（★フォルダーの中のファイルは消さない） */
  forget: () => Promise<void>;
}

export function useSharedFolder({
  storage,
  onSynced,
}: {
  storage: {
    restored: boolean;
    canPersist: boolean;
    setStorageError: (value: string | null) => void;
    refreshUsage: () => void;
  };
  /** 同期でこの端末の保存が変わったあと（画面の写しを読み直してもらう） */
  onSynced: (report: SyncReport) => void | Promise<void>;
}): SharedFolderHook {
  const [handle, setHandle] = useState<BrowserDirHandle | null>(null);
  const [state, setState] = useState<SharedFolderState>("none");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);

  const folderRef = useRef<SharedFolder | null>(null);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ★毎レンダー作り直される関数を effect の依存に入れないための控え
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const canPersistRef = useRef(storage.canPersist);
  canPersistRef.current = storage.canPersist;

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /** 1回分の同期。フォルダーそのものが使えないときだけ state を error にする */
  const runSync = useCallback(async (folder: SharedFolder, allow: { allowFirstWrite?: boolean; allowLedgerReplace?: boolean }) => {
    if (!canPersistRef.current || busyRef.current) return;
    busyRef.current = true;
    setSyncing(true);
    try {
      const next = await syncShared(folder, allow);
      setReport(next);
      setLastSync(await loadLastSync());
      setError(null);
      await onSyncedRef.current(next);
    } catch (e) {
      setState("error");
      setError(sharedErrorText(e));
    } finally {
      busyRef.current = false;
      setSyncing(false);
    }
  }, []);

  const open = useCallback(
    async (dir: BrowserDirHandle, askPermission: boolean) => {
      setState("connecting");
      setError(null);
      try {
        if (askPermission) await ensureFolderPermission(dir);
        const folder = new SharedFolder(new FolderStore(dir), await loadDeviceId());
        await folder.probe();
        folderRef.current = folder;
        setState("connected");
        await runSync(folder, {});
      } catch (e) {
        folderRef.current = null;
        setState("error");
        setError(sharedErrorText(e));
      }
    },
    [runSync],
  );

  // 前回選んだフォルダーの許可がまだ生きていれば、尋ねずにつないで同期する
  useEffect(() => {
    if (!storage.restored || !handle || state !== "prompt") return;
    let alive = true;
    void queryFolderPermission(handle).then((permission) => {
      if (alive && permission === "granted") void open(handle, false);
    });
    return () => {
      alive = false;
    };
  }, [storage.restored, handle, state, open]);

  return {
    state,
    folderName: handle?.name ?? null,
    lastSync,
    syncing,
    error,
    report,
    connected: state === "connected",

    restore: async () => {
      if (!isFolderAccessSupported()) {
        setState("unsupported");
        return;
      }
      const [saved, at] = await Promise.all([loadSharedFolderHandle(), loadLastSync()]);
      setLastSync(at);
      if (!saved) return;
      setHandle(saved);
      setState("prompt");
    },

    choose: async () => {
      setError(null);
      try {
        const picked = await pickFolder("shared");
        if (!picked) return; // 選ぶのをやめた
        setHandle(picked);
        setReport(null);
        folderRef.current = null;
        await saveSharedFolderHandle(picked);
        await open(picked, true);
      } catch (e) {
        setState("error");
        setError(sharedErrorText(e));
      }
    },

    connect: async () => {
      if (handle) await open(handle, true);
    },

    sync: async (options = {}) => {
      const folder = folderRef.current;
      if (!folder) return;
      await runSync(folder, options);
      storage.refreshUsage();
    },

    scheduleSync: () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const folder = folderRef.current;
        // ★初回の書き出しと顧客ファイルの入れ替えは、ここでは許さない（ボタンで確かめてから）
        if (folder) void runSync(folder, {});
      }, SYNC_DEBOUNCE_MS);
    },

    putCustomerFile: async (name, bytes, source) => {
      const folder = folderRef.current;
      if (!folder) return null;
      try {
        // ★共有データのフォルダーへ置く（直下は業務のフォルダーだけにしておく）
        const dir = await folder.ensureDataDir();
        await folder.store.writeBytes([...dir, name], bytes);
        const seen = await loadSeenCustomerFiles();
        // ★Folio がこの端末から置いた、同じ取り込み元の古いファイルだけ片付ける
        //   （利用者が手で置いたファイルには触らない）。放っておくと
        //   「同じ取り込み元が2つ」になって、どちらを使うか決められなくなる
        const stale = staleWrittenFiles(seen, source, name);
        for (const old of stale) await folder.store.remove([...dir, old]).catch(() => undefined);
        const next = { ...seen };
        for (const old of stale) delete next[old];
        const stat = await folder.store.stat([...dir, name]);
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
    },

    forget: async () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      folderRef.current = null;
      setHandle(null);
      setReport(null);
      setLastSync(null);
      setError(null);
      setState(isFolderAccessSupported() ? "none" : "unsupported");
      try {
        await clearSharedFolder();
      } catch (e) {
        storage.setStorageError(
          `共有フォルダーの登録を消せませんでした (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    },
  };
}
