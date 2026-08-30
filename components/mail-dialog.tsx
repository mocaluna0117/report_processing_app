"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { buildMailText } from "@/lib/email";
import type { ResultRow } from "@/lib/process";
import { ADDRESS_COL, HANDOVER_COL, OWNER_COL, PROPERTY_COL, SUMMARY_COL } from "@/lib/tsv";

/**
 * メール本文に貼るテキストの確認・コピー用ダイアログ。
 * 文面は結果テーブルの現在値 (編集済みならその値) から毎回組み立てる。
 * カナは Gemini の推定値がプリセットされるが、必ずここで目視・修正できるようにする。
 */
export function MailDialog({
  row,
  onKanaChange,
  onClose,
}: {
  row: ResultRow;
  onKanaChange: (pairId: string, kana: string) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fromDatabase = row.kind === "after";

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const text = useMemo(
    () =>
      buildMailText({
        handoverDate: row.cells[HANDOVER_COL],
        propertyName: row.cells[PROPERTY_COL],
        ownerName: row.cells[OWNER_COL],
        ownerKana: row.mail.ownerKana,
        address: row.cells[ADDRESS_COL],
        contacts: row.mail.contacts,
        summary: row.cells[SUMMARY_COL],
      }),
    [row],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // クリップボードが使えない環境では、そのまま手でコピーできるよう全選択する
      textareaRef.current?.select();
    }
  };

  const kanaClass =
    row.mail.kanaConfidence === "fail"
      ? "border-red-300 bg-red-50"
      : row.mail.kanaConfidence === "warn"
        ? "border-amber-300 bg-amber-50"
        : "border-slate-300 bg-white";

  const uncertainContacts = row.mail.contacts.some((c) => c.confidence === "warn");

  return (
    <ModalShell
      label={`メール文 ${row.ownerDisplay}`}
      onClose={onClose}
      panelClassName="w-full max-w-3xl rounded-xl bg-white p-5 shadow-xl"
    >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">メール文 — {row.ownerDisplay}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              物件名・住所・依頼内容は結果テーブルの現在値から作られます（テーブルで直すと反映されます）
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>

        <label className="mt-4 block text-sm">
          <span className="font-medium">施主名のカナ</span>
          <span className="ml-2 text-xs text-slate-500">
            {row.mail.kanaConfidence === "fail"
              ? fromDatabase
                ? "顧客データに読みがありません。手入力してください"
                : "取得できませんでした。手入力してください"
              : fromDatabase
                ? "顧客データの読みです。念のため確認してください"
                : row.mail.kanaConfidence === "warn"
                  ? "Geminiの推定です。読みが複数ありえるので確認してください"
                  : "Geminiの推定です。念のため確認してください"}
          </span>
          <input
            value={row.mail.ownerKana}
            onChange={(e) => onKanaChange(row.pairId, e.target.value)}
            placeholder="フカホリ　ヨシコ"
            className={`mt-1 w-full rounded border px-2 py-1.5 text-sm ${kanaClass}`}
          />
          {row.mail.kanaAlternatives.length > 0 && (
            <span className="mt-1 block text-xs text-amber-800">
              他の読みの候補: {row.mail.kanaAlternatives.join("／")}
            </span>
          )}
        </label>

        {uncertainContacts && (
          <p className="mt-2 text-xs text-amber-800">
            連絡先はハイフン無しの番号から区切りを推定しました。市外局番によっては区切り位置が異なるので確認してください
          </p>
        )}
        {row.mail.contacts.length === 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {fromDatabase
              ? "顧客データに電話番号が無いため空欄です。必要なら貼り付け後に補ってください"
              : "連絡先は点検報告書から取得できなかったため空欄です。必要なら貼り付け後に補ってください"}
          </p>
        )}

        <textarea
          ref={textareaRef}
          readOnly
          value={text}
          rows={Math.min(20, text.split("\n").length + 1)}
          onFocus={(e) => e.target.select()}
          className="mt-3 w-full rounded-md border border-slate-300 p-3 font-mono text-sm leading-relaxed"
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={copy}
            className={`rounded-lg px-5 py-2 text-sm font-semibold text-white shadow-sm ${
              copied ? "bg-emerald-500" : "bg-emerald-600 hover:bg-emerald-700"
            }`}
          >
            {copied ? "コピーしました ✓" : "メール文をコピー"}
          </button>
        </div>
    </ModalShell>
  );
}
