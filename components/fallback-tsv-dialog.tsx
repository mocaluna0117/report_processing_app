"use client";

import { useEffect, useRef } from "react";
import { ModalShell } from "@/components/modal-shell";

/** クリップボードにアクセスできない環境で、手動コピーしてもらうためのダイアログ */
export function FallbackTsvDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <ModalShell
      label="クリップボードにアクセスできませんでした"
      onClose={onClose}
      panelClassName="w-full max-w-3xl rounded-xl bg-white p-5 shadow-xl"
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
    </ModalShell>
  );
}
