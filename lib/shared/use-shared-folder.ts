"use client";

// 共有フォルダーのつながり（lib/shared/connection.ts。Folio 全体で1つ）を、画面から使うための薄い hook。
// 判断と文言は lib/shared/status.ts、読み書きは lib/shared/folder.ts と lib/shared/sync.ts にある。
//
// ★許可を尋ねる（requestPermission）のは**利用者がボタンを押した処理の中だけ**（choose / connect）。
// ★自動で同期するのは、共有データを使う画面（定期点検・アフター・顛末書）が開いているときだけ。
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CustomerSource } from "@/lib/after/types";
import {
  type SharedConnection,
  chooseSharedFolder,
  connectSharedFolder,
  forgetSharedFolder,
  getSharedConnection,
  onSharedSynced,
  putSharedCustomerFile,
  restoreSharedConnection,
  scheduleSharedSync,
  subscribeSharedConnection,
  syncSharedNow,
  wantSharedSync,
} from "@/lib/shared/connection";
import type { SharedFolderState } from "@/lib/shared/status";
import type { SyncReport } from "@/lib/shared/sync";

export interface SharedFolderHook {
  /** 前回の登録を読み終えたか（サーバーで描いた直後は false） */
  known: boolean;
  state: SharedFolderState;
  folderName: string | null;
  lastSync: number | null;
  syncing: boolean;
  error: string | null;
  report: SyncReport | null;
  /** つないでいるか（消去の確認文の出し分けに使う） */
  connected: boolean;
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

const subscribe = (onChange: () => void) => subscribeSharedConnection(onChange);
/** ★サーバーで描くとき・読み込み直後の1回目は、まだ何も読んでいない形で描く（食い違わせない） */
const serverSnapshot = (): SharedConnection => SERVER_SNAPSHOT;
const SERVER_SNAPSHOT: SharedConnection = {
  known: false,
  state: "none",
  folderName: null,
  lastSync: null,
  syncing: false,
  error: null,
  report: null,
};

/** 共有フォルダーのつながりの今の状態（どの画面から見ても同じ） */
export function useSharedConnection(): SharedConnection {
  return useSyncExternalStore(subscribe, getSharedConnection, serverSnapshot);
}

/**
 * 共有データを使う画面が開いているあいだ呼ぶ（定期点検・アフター・顛末書）。
 * 前回のフォルダーの許可が生きていればつなぎ、開いたときに相手の分を取り込む。
 * ★専決決裁書・捺印決裁書では呼ばない（enabled を false にする）。
 */
export function useSharedSyncOnOpen(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    void restoreSharedConnection();
    return wantSharedSync();
  }, [enabled]);
}

/**
 * 同期でこの端末の保存が変わったあとに呼ばれる（画面の写しを読み直す）。
 * ★どこから始めた同期でも呼ばれる（ヘッダーから同期しても、開いている画面が読み直す）。
 */
export function useOnSharedSynced(listener: (report: SyncReport) => void | Promise<void>): void {
  // ★毎レンダー作り直される関数を effect の依存に入れないための控え
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => onSharedSynced((report) => ref.current(report)), []);
}

/** 画面の欄から使う形（アフターの欄とヘッダーのモーダルで同じ） */
export function useSharedFolderPanel(options: { refreshUsage?: () => void } = {}): SharedFolderHook {
  const connection = useSharedConnection();
  const refreshRef = useRef(options.refreshUsage);
  refreshRef.current = options.refreshUsage;
  return {
    ...connection,
    connected: connection.state === "connected",
    choose: chooseSharedFolder,
    connect: connectSharedFolder,
    sync: async (allow = {}) => {
      await syncSharedNow(allow);
      refreshRef.current?.();
    },
    scheduleSync: scheduleSharedSync,
    putCustomerFile: putSharedCustomerFile,
    forget: forgetSharedFolder,
  };
}

/**
 * アフターの画面から使う形。共有データを使う画面として同期を頼み、
 * 同期が済んだら onSynced で画面の写しを読み直してもらう。
 * ★ページの復元（storage.restored）が済むまでは読み直しを待たせ、済んだら順に流す
 *   （復元の途中で読み直すと、復元が読んだ古い写しで上書きされることがある）。
 */
export function useSharedFolder({
  storage,
  onSynced,
}: {
  storage: { restored: boolean; refreshUsage: () => void };
  onSynced: (report: SyncReport) => void | Promise<void>;
}): SharedFolderHook {
  useSharedSyncOnOpen();
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const restoredRef = useRef(storage.restored);
  restoredRef.current = storage.restored;
  const waiting = useRef<SyncReport[]>([]);

  useOnSharedSynced(async (report) => {
    if (!restoredRef.current) {
      waiting.current.push(report);
      return;
    }
    await onSyncedRef.current(report);
  });
  useEffect(() => {
    if (!storage.restored || waiting.current.length === 0) return;
    const reports = waiting.current;
    waiting.current = [];
    void (async () => {
      for (const report of reports) await onSyncedRef.current(report);
    })();
  }, [storage.restored]);

  return useSharedFolderPanel({ refreshUsage: storage.refreshUsage });
}
