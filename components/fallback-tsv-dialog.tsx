"use client";

import { useEffect, useRef } from "react";

/** クリップボードにアクセスできない環境で、手動コピーしてもらうためのダイアログ */
export function FallbackTsvDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="クリップボードにアクセスできませんでした"
        className="w-full max-w-3xl rounded-xl bg-white p-5 shadow-xl"
      >
        <h3 className="font-semibold">クリップボードにアクセスできませんでした</h3>
        <p className="mt-1 text-sm text-slate-600">
          下のテキストを全選択 (Ctrl/Cmd+A) してコピーし、Excelに貼り付けてください。
        </p>
        <textarea
          readOnly
          value={text}
          rows={10}
          onFocus={(e) => e.target.select()}
          className="mt-3 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
        />
        <div className="mt-3 text-right">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
