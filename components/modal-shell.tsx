"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * ダイアログの外枠 (メール文・完了報告書・コピーのフォールバックで共通)。
 * Esc と外側のクリックで閉じられる。
 */
export function ModalShell({
  label,
  onClose,
  panelClassName,
  children,
}: {
  /** 読み上げ用の名前 */
  label: string;
  onClose: () => void;
  panelClassName: string;
  children: ReactNode;
}) {
  /**
   * 外側で押して外側で離したときだけ閉じる。
   * 中の文字を選択して外までドラッグしたときに閉じてしまうのを防ぐ。
   */
  const pressedOutside = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景のクリックで閉じる (Escでも閉じられる)
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        pressedOutside.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOutside.current) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={label} className={panelClassName}>
        {children}
      </div>
    </div>
  );
}
