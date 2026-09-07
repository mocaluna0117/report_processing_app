"use client";

// 「確定後のPDF」を縦に並べたページの一覧。
//
// ★PDFを組み直さない。土台のPDF（PCから取った1本）と、入れた書類を**別々に描いて**
//   並べるだけにする。こうすると数十MBの土台を操作のたびに読み直さずに済み、
//   スクロールの位置も飛ばない（pdf-lib で毎回結合すると操作ごとに数秒かかる）。
// ★描いた絵は「どのPDFの何ページ目か」で覚える。並べ替え・外すでは描き直さない。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadPdfjs } from "@/lib/pdf/extract";
import type { ChosenFile } from "@/lib/tenmatsu/pending";
import {
  PLACEHOLDER_CONVERT,
  PLACEHOLDER_UNREADABLE,
  type PreviewSegment,
  imagePageBox,
  renderableKind,
} from "@/lib/tenmatsu/preview";

const PAGE_CLASS = "w-full rounded border border-slate-300 bg-white shadow-sm";
/** 何も描けていないときの紙（A4縦の比） */
const A4_RATIO = "1 / 1.414";

/** 描いた1ページ */
interface Rendered {
  /** JPEG の data URL */
  src: string;
}

/** 中身の在処。id が同じなら同じPDFとして1回だけ開く */
interface Source {
  id: string;
  bytes: () => Promise<Uint8Array>;
}

/** 並べる1枚 */
type Slot =
  | { key: string; label: string | null; kind: "pdf"; source: Source; page: number }
  | { key: string; label: string | null; kind: "image"; url: string }
  | { key: string; label: string | null; kind: "note"; text: string };

interface PdfDoc {
  numPages: number;
  render: (page: number, scale: number) => Promise<Rendered>;
  destroy: () => Promise<void>;
}

/** 入れた書類の中身をどこから読むかの名前（並べ替えでは変わらない） */
const sourceIdOf = (entry: ChosenFile): string =>
  `new:${entry.kept ?? entry.name}:${entry.size}`;

export function TenmatsuPreviewStrip({
  base,
  segments,
  fileOf,
  large,
  onCount,
}: {
  /** 土台のPDF（PCから取ったもの）。null なら土台のページは案内に置き換える */
  base: Blob | null;
  segments: readonly PreviewSegment[];
  /** 入れた書類の実体 */
  fileOf: (entry: ChosenFile) => File | undefined;
  /** 大きく描くか（既定は小さく描いて速くする） */
  large: boolean;
  /**
   * 実際に並べた枚数。★入れたPDFのページ数は開いてみないと分からないので、
   * 見出しの「全Nページ」はこの数を使う（内訳から数えると1枚と数えてしまう）
   */
  onCount?: (pages: number) => void;
}) {
  /** 先頭のバイトで見分けた中身（拡張子は当てにしない） */
  const [kinds, setKinds] = useState<Map<string, "pdf" | "image" | "other">>(new Map());
  /** PDFのページ数（source.id → ページ数） */
  const [pageCounts, setPageCounts] = useState<Map<string, number>>(new Map());
  /** 描いた絵（`${source.id}:${page}` → 絵） */
  const [rendered, setRendered] = useState<Map<string, Rendered>>(new Map());
  /** 開けなかったPDF（source.id） */
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const docs = useRef<Map<string, Promise<PdfDoc>>>(new Map());
  const urls = useRef<Map<string, string>>(new Map());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
      for (const doc of docs.current.values()) {
        void doc.then((d) => d.destroy()).catch(() => {});
      }
      docs.current.clear();
    };
  }, []);

  // 別の伝票を開いた・大きさを変えたら、覚えていた絵は捨てる
  useEffect(() => {
    setRendered(new Map());
  }, [base, large]);

  const urlOf = useCallback((id: string, file: File): string => {
    const found = urls.current.get(id);
    if (found) return found;
    const url = URL.createObjectURL(file);
    urls.current.set(id, url);
    return url;
  }, []);

  const openDoc = useCallback((source: Source): Promise<PdfDoc> => {
    const found = docs.current.get(source.id);
    if (found) return found;
    const opened = (async (): Promise<PdfDoc> => {
      const pdfjs = await loadPdfjs();
      const bytes = await source.bytes();
      // ★pdfjs は渡した bytes を worker へ移して使えなくするので、コピーを渡す
      const task = pdfjs.getDocument({ data: bytes.slice() });
      const doc = await task.promise;
      return {
        numPages: doc.numPages,
        render: async (page: number, scale: number) => {
          const p = await doc.getPage(page);
          const viewport = p.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await p.render({ canvas, viewport }).promise;
          const src = canvas.toDataURL("image/jpeg", 0.8);
          canvas.width = 0;
          canvas.height = 0;
          p.cleanup();
          return { src };
        },
        destroy: () => task.destroy(),
      };
    })();
    docs.current.set(source.id, opened);
    return opened;
  }, []);

  // --- 入れた書類の中身を見分ける（先頭のバイトだけ読む）
  useEffect(() => {
    const todo = segments.filter(
      (s): s is Extract<PreviewSegment, { kind: "file" }> =>
        s.kind === "file" && !kinds.has(sourceIdOf(s.entry)),
    );
    if (todo.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const seg of todo) {
        const id = sourceIdOf(seg.entry);
        const file = fileOf(seg.entry);
        if (!file) continue;
        let kind: "pdf" | "image" | "other" = "other";
        try {
          const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
          kind = renderableKind(file.name, head);
        } catch {
          kind = "other";
        }
        if (cancelled || !alive.current) return;
        setKinds((prev) => new Map(prev).set(id, kind));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [segments, kinds, fileOf]);

  const baseSource = useMemo<Source | null>(
    () =>
      base
        ? { id: "base", bytes: async () => new Uint8Array(await base.arrayBuffer()) }
        : null,
    [base],
  );

  // --- 並べる1枚ずつに分解する
  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    for (const seg of segments) {
      if (seg.kind === "base") {
        if (!baseSource || broken.has("base")) {
          out.push({ key: seg.key, label: seg.label, kind: "note", text: PLACEHOLDER_UNREADABLE });
          continue;
        }
        for (let page = seg.from + 1; page <= seg.to; page++) {
          out.push({
            key: `${seg.key}:${page}`,
            label: seg.label,
            kind: "pdf",
            source: baseSource,
            page,
          });
        }
        continue;
      }
      if (seg.kind === "placeholder") {
        out.push({
          key: seg.key,
          label: seg.entry?.name ?? null,
          kind: "note",
          text: seg.text,
        });
        continue;
      }
      const id = sourceIdOf(seg.entry);
      const file = fileOf(seg.entry);
      const kind = kinds.get(id);
      if (!file) {
        out.push({ key: seg.key, label: seg.entry.name, kind: "note", text: PLACEHOLDER_UNREADABLE });
        continue;
      }
      if (kind === undefined) {
        out.push({ key: seg.key, label: seg.entry.name, kind: "note", text: "読み込んでいます…" });
        continue;
      }
      if (kind === "other") {
        out.push({ key: seg.key, label: seg.entry.name, kind: "note", text: PLACEHOLDER_CONVERT });
        continue;
      }
      if (kind === "image") {
        out.push({ key: seg.key, label: seg.entry.name, kind: "image", url: urlOf(id, file) });
        continue;
      }
      if (broken.has(id)) {
        out.push({ key: seg.key, label: seg.entry.name, kind: "note", text: PLACEHOLDER_UNREADABLE });
        continue;
      }
      const source: Source = {
        id,
        bytes: async () => new Uint8Array(await file.arrayBuffer()),
      };
      const count = pageCounts.get(id) ?? 1;
      for (let page = 1; page <= count; page++) {
        out.push({
          key: `${seg.key}:${page}`,
          label: seg.entry.name,
          kind: "pdf",
          source,
          page,
        });
      }
    }
    return out;
  }, [segments, baseSource, broken, kinds, pageCounts, fileOf, urlOf]);

  // --- まだ描いていないページを上から順に描く
  useEffect(() => {
    const todo = slots.filter(
      (s): s is Extract<Slot, { kind: "pdf" }> =>
        s.kind === "pdf" && !rendered.has(`${s.source.id}:${s.page}`),
    );
    if (todo.length === 0) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void (async () => {
      for (const slot of todo) {
        if (cancelled || !alive.current) return;
        const cacheKey = `${slot.source.id}:${slot.page}`;
        try {
          const doc = await openDoc(slot.source);
          if (cancelled || !alive.current) return;
          if (pageCounts.get(slot.source.id) !== doc.numPages) {
            // ページ数が分かった（入れたPDFが複数ページだった）。並べ直してから描く
            setPageCounts((prev) => new Map(prev).set(slot.source.id, doc.numPages));
            if (slot.page > doc.numPages) continue;
          }
          const out = await doc.render(slot.page, large ? 1.1 : 0.45);
          if (cancelled || !alive.current) return;
          setRendered((prev) => new Map(prev).set(cacheKey, out));
        } catch {
          if (cancelled || !alive.current) return;
          docs.current.delete(slot.source.id);
          setBroken((prev) => new Set(prev).add(slot.source.id));
        }
      }
      if (!cancelled && alive.current) setBusy(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [slots, rendered, pageCounts, openDoc, large]);

  useEffect(() => {
    onCount?.(slots.length);
  }, [slots.length, onCount]);

  return (
    <div>
      {busy && <p className="mb-2 text-xs text-slate-500">ページを描いています…</p>}
      {slots.length === 0 && <p className="text-sm text-slate-500">出せるページがありません</p>}
      {/* ★小さいときは2列に並べる。1列だと1ページで縦がいっぱいになり、
          「どんな並びになるか」が一目で分からない */}
      <div className={large ? "space-y-3" : "grid grid-cols-2 gap-3"}>
      {slots.map((slot, i) => (
        <figure key={slot.key} className="space-y-1">
          <figcaption className="flex items-baseline gap-2 text-xs text-slate-500">
            <span className="tabular-nums">{i + 1}</span>
            <span className="truncate">{slot.label ?? ""}</span>
          </figcaption>
          {slot.kind === "note" ? (
            <div
              className={`${PAGE_CLASS} flex items-center justify-center bg-slate-50 p-4 text-center text-xs text-slate-600`}
              style={{ aspectRatio: A4_RATIO }}
            >
              {slot.text}
            </div>
          ) : slot.kind === "image" ? (
            <ImagePage url={slot.url} />
          ) : (
            <PdfPage rendered={rendered.get(`${slot.source.id}:${slot.page}`)} />
          )}
        </figure>
      ))}
      </div>
    </div>
  );
}

function PdfPage({ rendered }: { rendered: Rendered | undefined }) {
  if (!rendered) {
    return <div className={`${PAGE_CLASS} bg-slate-100`} style={{ aspectRatio: A4_RATIO }} aria-hidden />;
  }
  // 描いた絵をそのまま出す (next/image は blob/data URL を扱えないので img を使う)
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={rendered.src} alt="" className={PAGE_CLASS} />;
}

/** 画像の添付。PC側と同じ紙・同じ収め方で見せる（確定後の姿に合わせる） */
function ImagePage({ url }: { url: string }) {
  const [ratio, setRatio] = useState<number | null>(null);
  return (
    <div
      className={`${PAGE_CLASS} flex items-center justify-center p-2`}
      style={{ aspectRatio: ratio ? `1 / ${ratio}` : A4_RATIO }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        className="max-h-full max-w-full object-contain"
        onLoad={(e) => {
          const img = e.currentTarget;
          const page = imagePageBox(img.naturalWidth, img.naturalHeight);
          setRatio(page.pageHeight / page.pageWidth);
        }}
      />
    </div>
  );
}
