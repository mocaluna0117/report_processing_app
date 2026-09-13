"use client";

// PDFのプレビュー（ページを並べて出す／原寸のダイアログ）。
// 定期点検の結合PDF（「プレビュー」ボタン）と、完了報告書のダイアログで使う。
//
// ★描画はすべてこのブラウザの中で行う（PDFを外部へ送らない）。
// ★描き直すかどうかは source.key だけで決める（呼ぶ側がその場で作った入れ物を渡しても、
//   中身が同じなら描き直さない。オブジェクトの同一性で見ると毎回描き直して止まらなくなる）。
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { type RenderedPdfPage, renderPdfPages } from "@/lib/pdf/preview";

/** 何も描けていないときの紙（A4縦の比） */
const A4_RATIO = "1 / 1.414";

export interface PdfSource {
  /** 中身が同じなら同じ名前にする（描き直しの判断に使う） */
  key: string;
  load: () => Promise<Uint8Array>;
}

/**
 * PDFのページを上から順に並べて出す（完了報告書のプレビュー）。
 * source.key が変わるたびに描き直す。描いている間も前の絵は消さない（ちらつき防止）。
 */
export function PdfPagesPreview({
  source,
  width,
  maxPages = 20,
  onState,
}: {
  /** null なら「まだ作っていない」 */
  source: PdfSource | null;
  /** 画面に出す幅（px） */
  width: number;
  maxPages?: number;
  /** 描いている最中か・全何ページか・失敗したかを親に知らせる */
  onState?: (state: { busy: boolean; total: number | null; error: string | null }) => void;
}) {
  const [pages, setPages] = useState<RenderedPdfPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useRef(source?.load);
  load.current = source?.load;
  const notify = useRef(onState);
  notify.current = onState;
  const key = source?.key ?? null;

  useEffect(() => {
    if (key === null) {
      setPages([]);
      setError(null);
      return;
    }
    let alive = true;
    setBusy(true);
    notify.current?.({ busy: true, total: null, error: null });
    void (async () => {
      try {
        const bytes = await load.current?.();
        if (!bytes) throw new Error("PDFがありません");
        const { pages: drawn, total } = await renderPdfPages(bytes, { width, maxPages });
        if (!alive) return;
        setPages(drawn);
        setError(null);
        notify.current?.({ busy: false, total, error: null });
      } catch (e) {
        if (!alive) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        notify.current?.({ busy: false, total: null, error: message });
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, width, maxPages]);

  if (error) {
    return (
      <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
        プレビューを出せませんでした ({error})
      </p>
    );
  }
  if (pages.length === 0) {
    return (
      <div className="w-full rounded border border-slate-300 bg-white shadow-sm" style={{ aspectRatio: A4_RATIO }} />
    );
  }
  return (
    <div className={`space-y-2 ${busy ? "opacity-60" : ""}`}>
      {pages.map((page, i) => (
        <img
          // biome-ignore lint/suspicious/noArrayIndexKey: ページ番号がそのまま並び順
          key={i}
          src={page.src}
          alt={`${i + 1}ページ目`}
          className="w-full rounded border border-slate-300 bg-white shadow-sm"
        />
      ))}
    </div>
  );
}

/**
 * PDFをそのままブラウザのPDF表示で開くダイアログ（拡大・印刷ができる）。
 * blob URL は閉じるときに必ず解放する。
 */
export function PdfDocumentDialog({
  title,
  subtitle,
  load,
  onDownload,
  onClose,
}: {
  title: string;
  subtitle?: string;
  load: () => Promise<Blob>;
  /** 「ダウンロード」を出すなら渡す */
  onDownload?: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = await loadRef.current();
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      // 開くたびにPDF1本分のメモリが残らないように必ず解放する
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, []);

  return (
    <ModalShell
      label={title}
      onClose={onClose}
      panelClassName="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl bg-white p-6 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onDownload && (
            <button
              type="button"
              onClick={onDownload}
              className="cursor-pointer rounded-md border border-slate-800 bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900"
            >
              ダウンロード
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          PDFを開けませんでした ({error})
        </p>
      ) : url === null ? (
        <p className="mt-3 text-sm text-slate-600">PDFを読み込んでいます…</p>
      ) : (
        <>
          <iframe title={title} src={url} className="mt-3 h-[70vh] w-full rounded-md border border-slate-200" />
          <p className="mt-2 text-xs text-slate-500">
            白いままのときは、ブラウザのPDF表示が無効になっています。ダウンロードして開いてください。
          </p>
        </>
      )}
    </ModalShell>
  );
}
