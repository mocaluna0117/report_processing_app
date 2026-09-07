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
  type ChosenFile,
  PENDING_BUSY_TEXT,
  acceptMissingConfirmText,
  allowsMultiple,
  initialChosen,
  isAwaiting,
  isDefiniteFailure,
  missingReasonText,
  moveEntry,
  pendingErrorText,
  pendingIntroText,
  pendingPlan,
  recomposeConfirmText,
  recomposeIntroText,
  recomposeMissing,
  removeEntry,
  retryConfirmText,
  slotHintText,
} from "@/lib/tenmatsu/pending";

const PRIMARY_CLASS =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_CLASS =
  "rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";
const SMALL_BUTTON_CLASS =
  "rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 画面で持つ1件。kept はPC側にすでに入っているもの、file はこれから送るもの */
type Entry = ChosenFile & { file?: File };

/**
 * 保留中の伝票に書類を足して確定する / 確定した伝票の書類を差し替えるダイアログ。
 *
 * 欠けた添付1つにつき置き場を1つ出して、どれを差し替えるのかを明示する。
 * 保留になる主な原因は「このPCで Office の変換ができなかった」なので、
 * 利用者が Word/Excel を手でPDFにして入れ直すのが本来の使い方になる。
 * ＝ 元の添付とファイル名も拡張子も違うのが**普通**なので、名前では対応づけない。
 *
 * ★あとからアップロードする枠（捺印決裁書）は**複数のファイル**を入れられ、
 *   並び順もここで決める。送るのは常に「その枠の最終状態」1回分で、
 *   サーバーに途中の状態を持たない（だから確定後の差し替えも同じ画面で済む）。
 */
export function TenmatsuPendingDialog({
  kind,
  item,
  mode = "pending",
  complete,
  recompose,
  retry,
  onClose,
}: {
  kind: DocKind;
  item: ListItem;
  /** pending＝保留を確定する / recompose＝確定済みを組み直す */
  mode?: "pending" | "recompose";
  /** 確定する。行の差し替えまで済ませてから解決すること */
  complete?: (files: PendingFile[], slots: number[], acceptMissing: boolean) => Promise<void>;
  /** 組み直す。同上 */
  recompose?: (files: PendingFile[], slots: number[]) => Promise<void>;
  /** 保留を取り消す。同上 */
  retry?: () => Promise<void>;
  onClose: () => void;
}) {
  const recomposing = mode === "recompose";
  const missing = recomposing ? recomposeMissing(item) : (item.missing_attachments ?? []);
  // ★開いた時点で入っているものを初期の並びにする（何もしなければ今のまま確定できる）
  const [chosen, setChosen] = useState<Map<number, Entry[]>>(() => initialChosen(missing));
  const [busy, setBusy] = useState<"complete" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const plan = pendingPlan(missing, chosen);

  /** その枠の中身を差し替える（外す・足す・並べ替えの共通の入口） */
  const setSlot = (index: number, next: Entry[]) => {
    setChosen((prev) => {
      const map = new Map(prev);
      if (next.length > 0) map.set(index, next);
      else map.delete(index);
      return map;
    });
    setError(null);
  };

  const add = (index: number, files: File[], multiple: boolean) => {
    const entries: Entry[] = files.map((f) => ({ name: f.name, size: f.size, file: f }));
    const current = chosen.get(index) ?? [];
    setSlot(index, multiple ? [...current, ...entries] : entries.slice(0, 1));
  };

  const send = async (acceptMissing: boolean) => {
    setBusy("complete");
    setError(null);
    try {
      const files: PendingFile[] = [];
      for (const m of missing) {
        for (const entry of chosen.get(m.index) ?? []) {
          if (entry.kept) {
            files.push({ index: m.index, keep: entry.kept });
          } else if (entry.file) {
            files.push({
              index: m.index,
              name: entry.name,
              bytes: new Uint8Array(await entry.file.arrayBuffer()),
            });
          }
        }
      }
      // ★複数入る枠は「この1回で最終状態を全部指定した」ことを必ず伝える。
      //   伝えないと、全部外したときに「触れていない枠」と区別できない
      const slots = missing.filter(isAwaiting).map((m) => m.index);
      if (recomposing) await recompose?.(files, slots);
      else await complete?.(files, slots, acceptMissing);
      onClose();
    } catch (e) {
      setError(pendingErrorText(isDefiniteFailure(e), errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  const confirmAndSend = () => {
    if (!recomposing) {
      void send(false);
      return;
    }
    if (confirm(recomposeConfirmText(kind, item.file, kind.text.flagMarks))) void send(false);
  };

  const cancelPending = async () => {
    if (!confirm(retryConfirmText(kind, item.file))) return;
    setBusy("retry");
    setError(null);
    try {
      await retry?.();
      onClose();
    } catch (e) {
      setError(pendingErrorText(isDefiniteFailure(e), errorText(e)));
    } finally {
      setBusy(null);
    }
  };

  const label = recomposing ? kind.text.recomposeButton : kind.text.resolveButton;

  return (
    <ModalShell
      label={`${item.file} の${label}`}
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
            {item.senketsu_no ? ` / 専決決裁書 No.${item.senketsu_no}` : ""}
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
        {recomposing
          ? recomposeIntroText(kind, missing.filter((m) => m.optional).length)
          : pendingIntroText(kind, missing)}
      </p>

      <ul className="mt-3 space-y-3" aria-busy={busy !== null}>
        {missing.map((m) => {
          const entries = chosen.get(m.index) ?? [];
          const multiple = allowsMultiple(m);
          const changed = plan.extensionChanged.some((x) => x.index === m.index);
          return (
            <li key={m.index} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-700">{m.name}</p>
              {!isAwaiting(m) && (
                <p className="mt-0.5 text-xs text-amber-700">{missingReasonText(m)}</p>
              )}
              {isAwaiting(m) && (
                <p className="mt-0.5 text-xs text-sky-700">
                  {slotHintText(entries.length, multiple)}
                </p>
              )}
              {/* 入れたものの並び。この順番でPDFに入る */}
              {isAwaiting(m) && entries.length > 0 && (
                <ol className="mt-2 space-y-1">
                  {entries.map((entry, i) => (
                    <li
                      key={`${entry.kept ?? entry.name}-${i}`}
                      className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
                    >
                      <span className="w-5 text-xs text-slate-500">{i + 1}.</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                        {entry.name}
                        <span className="ml-1 text-xs text-slate-500">
                          ({formatFileSize(entry.size)}
                          {entry.kept ? " / 入れてある書類" : ""})
                        </span>
                      </span>
                      {multiple && (
                        <>
                          <button
                            type="button"
                            aria-label={`${entry.name} を1つ上へ`}
                            title="1つ上へ"
                            disabled={i === 0 || busy !== null}
                            onClick={() => setSlot(m.index, moveEntry(entries, i, -1))}
                            className={SMALL_BUTTON_CLASS}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`${entry.name} を1つ下へ`}
                            title="1つ下へ"
                            disabled={i === entries.length - 1 || busy !== null}
                            onClick={() => setSlot(m.index, moveEntry(entries, i, 1))}
                            className={SMALL_BUTTON_CLASS}
                          >
                            ↓
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        aria-label={`${entry.name} を外す`}
                        disabled={busy !== null}
                        onClick={() => setSlot(m.index, removeEntry(entries, i))}
                        className={SMALL_BUTTON_CLASS}
                      >
                        外す
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-2">
                <Dropzone
                  compact
                  multiple={multiple}
                  disabled={busy !== null}
                  accept={ATTACHMENT_ACCEPT}
                  pattern={ATTACHMENT_PATTERN}
                  onFiles={(files) => add(m.index, files, multiple)}
                  title={
                    isAwaiting(m)
                      ? multiple
                        ? "書類をここにドロップ (クリックで選択・複数可)"
                        : "アップロードする書類をここにドロップ (クリックで選択)"
                      : entries.length > 0
                        ? `${entries[0].name} (${formatFileSize(entries[0].size)})`
                        : m.filled
                          ? `入れてある: ${m.filled.name} (選び直せます)`
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
              {!isAwaiting(m) && entries.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSlot(m.index, [])}
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
          onClick={confirmAndSend}
          disabled={!plan.ready || plan.tooLarge || busy !== null}
          title={
            plan.ready
              ? recomposing
                ? "この並びで組み直して、同じファイル名で保存し直します"
                : undefined
              : plan.hasAwaiting
                ? "アップロードする書類を入れると確定できます"
                : `まだ ${plan.unfilled.length}件のファイルが選ばれていません`
          }
          className={PRIMARY_CLASS}
        >
          確定する
        </button>
        {!recomposing && !plan.ready && !plan.hasAwaiting && (
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
        {!recomposing && (
          <button
            type="button"
            onClick={() => void cancelPending()}
            disabled={busy !== null}
            className={DANGER_CLASS}
          >
            取り消して次回取り直す
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {recomposing
          ? `組み直すと${kind.text.flagMarks}は外れます。クラウドへ入れ直してください`
          : `「取り消して次回取り直す」を押すと保留中のPDFは消え、次に「${kind.label}を取得」を押したときにこの伝票を取り直します (添付が一時的に取れなかっただけのときはこちらが確実です)。`}
      </p>
    </ModalShell>
  );
}
