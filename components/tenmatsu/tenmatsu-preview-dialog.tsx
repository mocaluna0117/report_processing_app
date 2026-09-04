"use client";

import { useEffect, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { type ListItem, formatFetchedAt } from "@/lib/tenmatsu/client";

/**
 * 取得済み顛末書のプレビュー。
 * トークンをヘッダーで送る必要があるので iframe の src には直接URLを入れられない。
 * fetch → Blob → blob URL に置き換えて表示し、閉じるときに必ず revoke する。
 * ダウンロードのボタンは置かない (PDFの実体はPCの保存先フォルダにある)。
 */
export function TenmatsuPreviewDialog({
  item,
  saveDir,
  load,
  onClose,
}: {
  item: ListItem;
  /** PDFの置き場所 (/health の save_dir)。案内に出すだけ */
  saveDir: string | null;
  load: (no: string) => Promise<Blob>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    // 一覧に記録はあるが実ファイルが消えている行 (呼ぶ側でも押せなくしてあるが念のため)
    if (!item.exists) {
      setError(
        "このPDFはPCの保存先フォルダから消えています。もう一度「顛末書を取得」で取得し直してください",
      );
      return;
    }
    let done = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const blob = await load(item.denpyo_no);
        if (done) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (done) return;
        setError(
          `プレビューを表示できませんでした (${e instanceof Error ? e.message : String(e)})。` +
            "PCの保存先フォルダから直接開いてください",
        );
      }
    })();
    return () => {
      done = true;
      // 閉じたら必ず解放する (開くたびにPDF1本分のメモリが残らないように)
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [item.denpyo_no, item.exists, load]);

  return (
    <ModalShell
      label={item.file}
      onClose={onClose}
      panelClassName="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{item.file}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            伝票No. {item.denpyo_no}
            <span className="ml-2">取得 {formatFetchedAt(item.at)}</span>
            {saveDir && <span className="ml-2">保存先: {saveDir}</span>}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="shrink-0 cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          閉じる
        </button>
      </div>

      {error ? (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : url === null ? (
        <p className="mt-3 text-sm text-slate-600">PDFを読み込んでいます…</p>
      ) : (
        <>
          <iframe
            title={item.file}
            src={url}
            className="mt-3 h-[70vh] w-full rounded-md border border-slate-200"
          />
          <p className="mt-2 text-xs text-slate-500">
            白いままのときは、ブラウザのPDF表示が無効になっています。PCの保存先フォルダから直接開いてください。
          </p>
        </>
      )}
    </ModalShell>
  );
}
