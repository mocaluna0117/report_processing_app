"use client";

import { useEffect, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { downloadBytes } from "@/lib/download";
import {
  type InquiryExample,
  isInquiryExampleLike,
  EXAMPLES_PICK_DEFAULT,
} from "@/lib/summarize/examples";

const JSON_MIME = "application/json";
const EXPORT_NAME = "folio-学習した書き方.json";

const formatDateTime = (ms: number) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));

/**
 * 学習した書き方の確認・削除・受け渡し。
 * 保存しているのは伏せ字済みの本文だけなので、ここで全文を見て確かめられるようにする。
 */
export function InquiryExamplesDialog({
  examples,
  onDelete,
  onClearAll,
  onImport,
  onClose,
}: {
  examples: InquiryExample[];
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onImport: (examples: InquiryExample[]) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // 新しく学習したものから見せる (直近の手直しを確認しやすい)
  const sorted = [...examples].sort((a, b) => b.updatedAt - a.updatedAt);

  const exportJson = () => {
    const text = JSON.stringify(examples, null, 2);
    downloadBytes(new TextEncoder().encode(text), EXPORT_NAME, JSON_MIME);
  };

  const importJson = async (file: File) => {
    setError(null);
    try {
      const raw: unknown = JSON.parse(await file.text());
      const list = Array.isArray(raw) ? raw.filter(isInquiryExampleLike) : [];
      if (list.length === 0) {
        setError("学習した書き方が入っていないファイルです");
        return;
      }
      onImport(list);
    } catch (e) {
      setError(`読み込めませんでした (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  return (
    <ModalShell
      label="学習した書き方"
      onClose={onClose}
      panelClassName="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-white p-5 shadow-xl"
    >
      <div>
        <h2 className="text-lg font-semibold">学習した書き方 {examples.length}件</h2>
        <p className="mt-1 text-xs text-slate-500">
          受付を要約するとき、今回の受付メモに近いものを最大{EXAMPLES_PICK_DEFAULT}件まで手本として
          Gemini に送ります。保存・送信しているのは、お客様の氏名・電話番号・住所・メールアドレスを
          伏せ字にした本文だけです。
        </p>
      </div>

      {error && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>
      )}

      <div className="mt-3 flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-500">
            まだ学習していません。受付一覧の「この書き方を学習」で覚えさせてください。
          </p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((example) => (
              <li key={example.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-slate-500">
                    {formatDateTime(example.updatedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onDelete(example.id)}
                    className="shrink-0 cursor-pointer rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    削除
                  </button>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-slate-500">
                    受付メモ (伏せ字済み)
                  </summary>
                  <p className="mt-1 whitespace-pre-line rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
                    {example.input}
                  </p>
                </details>
                <p className="mt-1.5 text-xs text-slate-500">アフター受付内容</p>
                <p className="whitespace-pre-line text-sm">{example.output}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {examples.length > 0 && (
            <>
              <button
                type="button"
                onClick={onClearAll}
                className="cursor-pointer rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                すべて消去
              </button>
              <button
                type="button"
                onClick={exportJson}
                className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
              >
                JSONで書き出す
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
          >
            JSONを読み込む
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importJson(file);
            }}
          />
          <span className="text-[11px] text-slate-400">
            別の端末・ブラウザへ移すときに使います
          </span>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          閉じる
        </button>
      </div>
    </ModalShell>
  );
}
