"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { type ListItem, formatFetchedAt, formatFileSize } from "@/lib/tenmatsu/client";
import type { DocKind } from "@/lib/tenmatsu/kinds";
import type { RelinkCandidate } from "@/lib/tenmatsu/local/relink";

const pad = (n: number) => String(n).padStart(2, "0");
const formatModified = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 「ファイルなし」になった保存済みの伝票に、保存先のPDFを選び直して結ぶ。
 * ★名前を変える前に指紋を残していなかった記録（この機能より前に取得したもの）のための道。
 *   指紋がある記録は一覧を読み込んだときに自動で結び直るので、ここに来るのは自動で決まらなかった分。
 * ★選べるのは、保存先フォルダーの直下にある、どの記録にも使われていないPDFだけ。
 */
export function TenmatsuRelinkDialog({
  kind,
  item,
  loadCandidates,
  loadPdf,
  relink,
  onClose,
}: {
  kind: DocKind;
  item: ListItem;
  loadCandidates: () => Promise<RelinkCandidate[]>;
  loadPdf: (name: string) => Promise<Blob>;
  relink: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<RelinkCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    loadCandidates()
      .then((list) => {
        if (!alive) return;
        setCandidates(list);
        // 中身が同じPDFが1つだけなら、はじめから選んでおく
        const same = list.filter((c) => c.sameContent === true);
        if (same.length === 1) setSelected(same[0].name);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [loadCandidates]);

  // 選んだPDFの中身を見せる（取り違えないように）。閉じるときに必ず解放する
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    let url: string | null = null;
    setPreviewUrl(null);
    setPreviewError(null);
    loadPdf(selected)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      })
      .catch((e) => {
        if (alive) setPreviewError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected, loadPdf]);

  const sameCount = useMemo(() => (candidates ?? []).filter((c) => c.sameContent === true).length, [candidates]);

  const submit = async () => {
    if (!selected) return;
    if (!confirm(`伝票№ ${item.denpyo_no} の記録を「${selected}」に結びます。よろしいですか？`)) return;
    setBusy(true);
    setError(null);
    try {
      await relink(selected);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      label={`${item.denpyo_no} のPDFを選び直す`}
      onClose={onClose}
      panelClassName="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white p-6 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">PDFを選び直す — 伝票№ {item.denpyo_no}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            記録の名前「{item.file}」のPDFが保存先に見つかりません。名前を変えた場合は、下から今の名前のPDFを選んでください
            (取得 {formatFetchedAt(item.at)})。選べるのは保存先フォルダーの直下にあり、ほかの{kind.label}の記録に使われていないPDFだけです。
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

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="mt-3 grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto">
          {candidates === null ? (
            <p className="text-sm text-slate-600">保存先のPDFを調べています…</p>
          ) : candidates.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              ほかの記録につながっていないPDFが、保存先フォルダーの直下にありません。
              サブフォルダーへ移した場合は直下へ戻してから「一覧を再読み込み」を押してください。
            </p>
          ) : (
            <fieldset>
              <legend className="text-xs text-slate-500">
                {sameCount > 0
                  ? `中身が記録と同じPDFが ${sameCount}件あります`
                  : "新しく保存した日時が取得日時に近い順に並べています"}
              </legend>
              <ul className="mt-1 space-y-1">
                {candidates.map((c) => (
                  <li key={c.name}>
                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-sm ${
                        selected === c.name ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="relink-candidate"
                        className="mt-1"
                        checked={selected === c.name}
                        onChange={() => setSelected(c.name)}
                      />
                      <span className="min-w-0">
                        <span className="block break-all font-medium">{c.name}</span>
                        <span className="block text-xs text-slate-500">
                          {formatFileSize(c.size)}・{formatModified(c.lastModified)}
                          {c.sameContent === true && (
                            <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">中身が記録と同じ</span>
                          )}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>

        <section className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-slate-50 p-3">
          <h4 className="text-sm font-semibold text-slate-700">選んだPDFの中身</h4>
          {!selected ? (
            <p className="mt-2 text-sm text-slate-500">左からPDFを選ぶと、ここに中身が出ます</p>
          ) : previewError ? (
            <p className="mt-2 text-sm text-red-800">中身を出せませんでした ({previewError})</p>
          ) : previewUrl === null ? (
            <p className="mt-2 text-sm text-slate-500">読み込んでいます…</p>
          ) : (
            <iframe title={selected} src={previewUrl} className="mt-2 h-[55vh] w-full rounded-md border border-slate-200 bg-white" />
          )}
        </section>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={!selected || busy}
          onClick={() => void submit()}
          className="cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "結んでいます…" : "このPDFに結ぶ"}
        </button>
      </div>
    </ModalShell>
  );
}
