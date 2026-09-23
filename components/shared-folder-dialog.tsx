"use client";

/**
 * 共有フォルダーの欄をモーダルで出す（Folio 全体で1つ。ヘッダーから開く）。
 *
 * ★中身はアフターメンテナンスの画面の欄と同じ部品（components/after/shared-folder.tsx）。
 *   つながりも同じ1つ（lib/shared/connection.ts）なので、どちらで押しても同じになる。
 * ★ここで許可を尋ねるのは、欄のボタンを押したときだけ（開いただけでは尋ねない）。
 */
import { useEffect, useState } from "react";
import { SharedFolderPanel } from "@/components/after/shared-folder";
import { ModalShell } from "@/components/modal-shell";
import { closeSharedDialog, isSharedDialogOpen, subscribeSharedDialog } from "@/lib/shared/dialog";
import { SHARED_DIALOG_LEAD } from "@/lib/shared/status";
import { useSharedFolderPanel } from "@/lib/shared/use-shared-folder";
import { isStorageAvailable } from "@/lib/storage";

export function SharedFolderDialog() {
  const [open, setOpen] = useState(isSharedDialogOpen);
  useEffect(() => subscribeSharedDialog(setOpen), []);
  const shared = useSharedFolderPanel();

  if (!open) return null;

  return (
    <ModalShell
      label="共有フォルダー"
      onClose={closeSharedDialog}
      panelClassName="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-bold text-slate-900">共有フォルダー</h2>
        <button
          type="button"
          onClick={closeSharedDialog}
          aria-label="閉じる"
          className="cursor-pointer rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          ✕
        </button>
      </div>
      <div className="overflow-y-auto px-5 py-4">
        <p className="mb-3 text-xs text-slate-500">{SHARED_DIALOG_LEAD}</p>
        <SharedFolderPanel shared={shared} canPersist={isStorageAvailable()} inDialog />
      </div>
    </ModalShell>
  );
}
