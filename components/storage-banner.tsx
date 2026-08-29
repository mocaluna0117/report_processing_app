"use client";

import type { ReactNode } from "react";
import type { LocalFontInfo } from "@/lib/report/fonts";

export interface StorageAction {
  label: string;
  onClick: () => void;
  /** 消去など取り消せない操作 */
  danger?: boolean;
}

/**
 * 画面下部の「ブラウザ内に保存しています」欄。
 * 何が保存され、何を消せるのかは画面ごとに違うので description と actions で渡す。
 */
export function StorageBanner({
  description,
  detail,
  usageBytes,
  fontInfo,
  actions,
  disabled,
  onClearFont,
}: {
  description: ReactNode;
  /** 件数など、画面ごとの補足 */
  detail?: ReactNode;
  usageBytes: number | null;
  fontInfo: LocalFontInfo | null;
  actions: StorageAction[];
  disabled?: boolean;
  onClearFont: () => void;
}) {
  return (
    <div className="mt-8 flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
      <span>
        {description}
        {detail && <span className="ml-1">{detail}</span>}
        {fontInfo && (
          <>
            {" "}
            完了報告書の書体として「{fontInfo.family}」を登録済みです。顧客データではないので消去では消えません。
          </>
        )}
        {usageBytes !== null && usageBytes > 0 && (
          <span className="ml-1 block text-slate-400">
            保存量 約{Math.round(usageBytes / 1024 / 1024)}MB
            {/* 保存量はブラウザの推定値で、実バイト数より小さく出ることがある。
                内訳が総量を超えて見えると誤解を招くので、収まるときだけ出す */}
            {fontInfo &&
              fontInfo.bytes < usageBytes &&
              `（うち登録した書体 約${Math.round(fontInfo.bytes / 1024 / 1024)}MB）`}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            disabled={disabled}
            className={
              action.danger
                ? "whitespace-nowrap rounded-md border border-red-300 bg-white px-3 py-1.5 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                : "whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            }
          >
            {action.label}
          </button>
        ))}
        {fontInfo && (
          <button
            type="button"
            onClick={onClearFont}
            disabled={disabled}
            className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            書体の登録を消す
          </button>
        )}
      </span>
    </div>
  );
}
