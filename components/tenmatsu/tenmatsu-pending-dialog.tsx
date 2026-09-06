"use client";

import { useEffect, useRef, useState } from "react";
import { Dropzone } from "@/components/dropzone";
import { ModalShell } from "@/components/modal-shell";
import { type ListItem, type PendingFile, formatFileSize } from "@/lib/tenmatsu/client";
import type { DocKind } from "@/lib/tenmatsu/kinds";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_PATTERN,
  ATTACHMENT_TYPES_TEXT,
  PENDING_BUSY_TEXT,
  acceptMissingConfirmText,
  isDefiniteFailure,
  pendingErrorText,
  pendingPlan,
  retryConfirmText,
} from "@/lib/tenmatsu/pending";

const PRIMARY_CLASS =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_CLASS =
  "rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 保留中の伝票に、欠けた添付を足して確定するダイアログ。
 *
 * 保留になる主な原因は「このPCで Office の変換ができなかった」なので、
 * 利用者が Word/Excel を手でPDFにして入れ直すのが本来の使い方になる。
 * ＝ 元の添付とファイル名も拡張子も違うのが**普通**なので、名前では対応づけない。
 * 欠けた添付1つにつき置き場を1つ出して、どれを差し替えるのかを明示する。
 */
export function TenmatsuPendingDialog({
  kind,
  item,
  complete,
  retry,
  onClose,
}: {
  kind: DocKind;
  item: ListItem;
  /** 確定する。行の差し替えまで済ませてから解決すること */
  complete: (files: PendingFile[], acceptMissing: boolean) => Promise<void>;
  /** 保留を取り消す。同上 */
  retry: () => Promise<void>;
  onClose: () => void;
}) {
  const missing = item.missing_attachments ?? [];
  const [chosen, setChosen] = useState<Map<number, File>>(new Map());
  const [busy, setBusy] = useState<"complete" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const plan = pendingPlan(missing, chosen);

  const pick = (index: number, file: File | null) => {
    setChosen((prev) => {
      const next = new Map(prev);
      if (file) next.set(index, file);
      else next.delete(index);
      return next;
    });
    setError(null);
  };

  const send = async (acceptMissing: boolean) => {
    setBusy("complete");
    setError(null);
    try {
      const files: PendingFile[] = await Promise.all(
        [...chosen].map(async ([index, file]) => ({
          index,
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      await complete(files, acceptMissing);
      onClose();
    } catch (e) {
      setError(pendingErrorText(isDefiniteFailure(e), errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  const cancelPending = async () => {
    if (!confirm(retryConfirmText(kind, item.file))) return;
    setBusy("retry");
    setError(null);
    try {
      await retry();
      onClose();
    } catch (e) {
      setError(pendingErrorText(isDefiniteFailure(e), errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ModalShell
      label={`${item.file} の添付を足す`}
      // ★送信中は閉じさせない (Esc・外側クリックの両方)。
      //   結合の途中で閉じると、成功したのか分からないまま行が残る
      onClose={busy ? () => {} : onClose}
      panelClassName="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-800">{item.file}</h2>
          <p className="mt-1 text-xs text-slate-500">
            伝票No. {item.denpyo_no}
            {item.property_name ? ` / ${item.property_name}` : ""}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          className={SECONDARY_CLASS}
        >
          閉じる
        </button>
      </div>

      <p className="mt-3 text-sm text-slate-600">
        本体と、結合できた添付は保留中のPDFに入っています。
        結合できなかったのは次の {missing.length}件です。手作業でPDFなどにしたものを入れて
        「確定する」を押すと、元の順番で結合し直して正式なフォルダへ保存します。
      </p>

      <ul className="mt-3 space-y-3" aria-busy={busy !== null}>
        {missing.map((m) => {
          const file = chosen.get(m.index);
          const changed = plan.extensionChanged.some((x) => x.index === m.index);
          return (
            <li key={m.index} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-700">{m.name}</p>
              <p className="mt-0.5 text-xs text-amber-700">{m.reason}</p>
              <div className="mt-2">
                <Dropzone
                  compact
                  multiple={false}
                  disabled={busy !== null}
                  accept={ATTACHMENT_ACCEPT}
                  pattern={ATTACHMENT_PATTERN}
                  onFiles={(files) => pick(m.index, files[0] ?? null)}
                  title={
                    file
                      ? `${file.name} (${formatFileSize(file.size)})`
                      : "差し替えるファイルをここにドロップ (クリックで選択)"
                  }
                  description={`対応形式: ${ATTACHMENT_TYPES_TEXT}`}
                />
              </div>
              {changed && (
                <p className="mt-1 text-xs text-slate-500">
                  元の添付と形式が違いますが、そのまま結合します
                </p>
              )}
              {file && (
                <button
                  type="button"
                  onClick={() => pick(m.index, null)}
                  disabled={busy !== null}
                  className="mt-1 text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-50"
                >
                  選び直す
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {busy === "complete" && <p className="mt-3 text-sm text-slate-600">{PENDING_BUSY_TEXT}</p>}
      {plan.tooLarge && (
        <p className="mt-3 text-sm text-red-700">
          選んだファイルの合計 ({formatFileSize(plan.totalBytes)}) が1回の上限を超えています。
          分けて確定するか、ファイルを小さくしてください
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void send(false)}
          disabled={!plan.ready || plan.tooLarge || busy !== null}
          title={
            plan.ready
              ? undefined
              : `まだ ${plan.unfilled.length}件のファイルが選ばれていません`
          }
          className={PRIMARY_CLASS}
        >
          確定する
        </button>
        {!plan.ready && (
          <button
            type="button"
            onClick={() => {
              if (confirm(acceptMissingConfirmText(kind, item.file, plan.unfilled))) {
                void send(true);
              }
            }}
            disabled={plan.tooLarge || busy !== null}
            className={SECONDARY_CLASS}
          >
            欠けたまま確定する
          </button>
        )}
        <button
          type="button"
          onClick={() => void cancelPending()}
          disabled={busy !== null}
          className={DANGER_CLASS}
        >
          取り消して次回取り直す
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        「取り消して次回取り直す」を押すと保留中のPDFは消え、次に「{kind.label}を取得」を
        押したときにこの伝票を取り直します (添付が一時的に取れなかっただけのときはこちらが確実です)。
      </p>
    </ModalShell>
  );
}
