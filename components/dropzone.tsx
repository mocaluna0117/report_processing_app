"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";

/** 既定は定期点検のPDF取り込み。顧客データ (xlsx/csv) では accept/pattern を差し替える */
export function Dropzone({
  onFiles,
  disabled,
  accept = ".pdf,application/pdf",
  pattern = /\.pdf$/i,
  multiple = true,
  title = "写真報告書・点検報告書のPDFをまとめてドロップ",
  description = (
    <>
      クリックしてファイルを選択もできます。ファイル名から自動でペアリングします。
      <br />
      PDFはブラウザ内で処理され、外部にアップロードされません。
    </>
  ),
  compact = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  accept?: string;
  /** 受け取るファイル名の条件 */
  pattern?: RegExp;
  multiple?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const acceptFiles = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const files = Array.from(list).filter((f) => pattern.test(f.name));
      if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
    },
    [onFiles, pattern, multiple],
  );

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        // 無効時は preventDefault しない = ブラウザがドロップ先と見なさない
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (disabled) return;
        acceptFiles(e.dataTransfer.files);
      }}
      className={`w-full rounded-xl border-2 border-dashed text-center transition-colors ${
        compact ? "p-5" : "p-10"
      } ${
        dragging
          ? "border-blue-500 bg-blue-50"
          : "border-slate-300 bg-white hover:border-blue-400 hover:bg-slate-50"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        className="hidden"
        onChange={(e) => {
          acceptFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <p className={compact ? "font-medium text-slate-700" : "text-lg font-medium text-slate-700"}>
        {title}
      </p>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </button>
  );
}
