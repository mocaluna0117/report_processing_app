"use client";

import { useCallback, useRef, useState } from "react";

export function Dropzone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name));
      if (pdfs.length > 0) onFiles(pdfs);
    },
    [onFiles],
  );

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files);
      }}
      className={`w-full rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
        dragging
          ? "border-blue-500 bg-blue-50"
          : "border-slate-300 bg-white hover:border-blue-400 hover:bg-slate-50"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="text-lg font-medium text-slate-700">
        写真報告書・点検報告書のPDFをまとめてドロップ
      </p>
      <p className="mt-1 text-sm text-slate-500">
        クリックしてファイルを選択もできます。ファイル名から自動でペアリングします。
        <br />
        PDFはブラウザ内で処理され、外部にアップロードされません。
      </p>
    </button>
  );
}
