// 「書類を足す」「差し替え」のダイアログの中に出す、確定後のPDFのプレビュー。
//
// PC側は1つの伝票につき1本のPDFしか返せない（保留中は _merged.pdf、確定後は保存したPDF）。
// そこで**そのPDFを土台**にして、利用者がいま選んだ書類をその位置へ差し込んだ姿を組み立てる。
// どのページが誰のものかは /list の pdf_layout（PC側が結合したときに数えた内訳）で分かる。
//
// ここは判定だけを純粋な関数で持つ（この repo の vitest は node 環境なので、
// 画面やcanvasの中では確かめられない）。実際に描くのは tenmatsu-preview-strip.tsx。
import type { ListItem, MissingAttachment, PdfLayoutEntry } from "@/lib/tenmatsu/client";
import { type ChosenFile, type ChosenMap, isKept } from "@/lib/tenmatsu/pending";

/** プレビューに並べるもの1つ */
export type PreviewSegment =
  /** 土台のPDFのページ範囲（to は含まない）。すでに入っている書類もここに写る */
  | { kind: "base"; key: string; from: number; to: number; label: string | null }
  /** これから入れる書類（中身はブラウザにあるので、そのまま描ける） */
  | { kind: "file"; key: string; index: number; entry: ChosenFile }
  /** 中身を出せないもの（Office など・PCにあるだけの書類）。位置だけ示す1枚 */
  | { kind: "placeholder"; key: string; index: number; entry?: ChosenFile; text: string };

/** ブラウザで中身を出せない形式の書類（確定時にPCで変換する） */
export const PLACEHOLDER_CONVERT =
  "確定するとPCでPDFに変換して、ここに入ります";
/** PDFとして読めなかった書類（PCのpypdfなら開けることがある） */
export const PLACEHOLDER_UNREADABLE =
  "この画面では表示できません（確定するとPCで結合します）";
/** すでにPC側に入っている書類で、中身をブラウザへ持っていないもの */
export const PLACEHOLDER_ON_PC =
  "PCに入れてある書類です（この画面では表示できません）";

/** プレビューを出せない理由。null なら出せる */
export function previewUnavailableReason(item: ListItem): string | null {
  if (item.pdf_layout === undefined) {
    return (
      "このPCのサーバーはプレビューに未対応です" +
      "（~/tenmatsu-dl/ を更新するか、「一覧を再読み込み」を押してください）"
    );
  }
  if (item.pdf_layout === null) {
    return item.pending === true
      ? "この保留はプレビューに必要な情報を持っていません（この機能より前に取得したものです）"
      : "この記録はプレビューに必要な情報を持っていません（一度「差し替え」で組み直すと出せます）";
  }
  if (!item.exists) {
    return "PCにPDFが見つからないので、プレビューを出せません";
  }
  return null;
}

/** 中身をブラウザで描ける形式か。★拡張子ではなく先頭のバイトで決める */
export function renderableKind(name: string, head: Uint8Array): "pdf" | "image" | "other" {
  const starts = (bytes: readonly number[]): boolean =>
    bytes.every((b, i) => head[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (starts([0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "image"; // PNG
  // 先頭が読めないときだけ名前で判断する（0バイトのPDFなど）
  if (head.length === 0) {
    const ext = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";
    if (ext === "pdf") return "pdf";
    if (ext === "jpg" || ext === "jpeg" || ext === "png") return "image";
  }
  return "other";
}

/** A4（pt）。PC側の PAGE_SIZES_PT と同じ値 */
export const A4_PT: { width: number; height: number } = { width: 595.28, height: 841.89 };
/** 画像の余白（PC側 merge.image_margin_mm の既定値 10mm を pt に） */
export const IMAGE_MARGIN_PT = 10 * 2.834645669;

/**
 * 画像を1ページにするときの紙と描画位置。
 * ★PC側 image_to_pdf_bytes と同じ規則にする（横長の画像は紙も横向き、余白を引いた中で
 *   縦横比を保って最大化し、中央に置く）。設定値は folio から読めないので既定値で合わせる。
 */
export function imagePageBox(
  imageWidth: number,
  imageHeight: number,
): { pageWidth: number; pageHeight: number; drawWidth: number; drawHeight: number; x: number; y: number } {
  let pageWidth = A4_PT.width;
  let pageHeight = A4_PT.height;
  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);
  if (w > h && pageWidth - 2 * IMAGE_MARGIN_PT < pageHeight - 2 * IMAGE_MARGIN_PT) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth];
  }
  const availWidth = pageWidth - 2 * IMAGE_MARGIN_PT;
  const availHeight = pageHeight - 2 * IMAGE_MARGIN_PT;
  const scale = Math.min(availWidth / w, availHeight / h);
  const drawWidth = w * scale;
  const drawHeight = h * scale;
  return {
    pageWidth,
    pageHeight,
    drawWidth,
    drawHeight,
    x: (pageWidth - drawWidth) / 2,
    y: (pageHeight - drawHeight) / 2,
  };
}

/** 枠に入っているファイルの、土台の中での範囲（pdf_layout の並びから求める） */
function baseRanges(layout: readonly PdfLayoutEntry[]): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>();
  let at = 0;
  for (const entry of layout) {
    if (entry.file) out.set(`${entry.index}:${entry.file}`, { from: at, to: at + entry.pages });
    at += entry.pages;
  }
  return out;
}

/** その index の部品が土台の何ページ目から始まるか */
function startOf(layout: readonly PdfLayoutEntry[], index: number): number {
  let at = 0;
  for (const entry of layout) {
    if (entry.index >= index) break;
    at += entry.pages;
  }
  return at;
}

/** その index の部品が土台で使っているページ数 */
function pagesOf(layout: readonly PdfLayoutEntry[], index: number): number {
  return layout.reduce((sum, e) => (e.index === index ? sum + e.pages : sum), 0);
}

const entryKey = (index: number, entry: ChosenFile, at: number): string =>
  `${index}:${entry.kept ?? `new:${entry.name}:${entry.size}`}:${at}`;

/**
 * 確定後のPDFに何がどの順で並ぶかを組み立てる。
 *
 * missing（枠と欠け）を index の順に辿り、土台のページと、利用者が選んだ書類を
 * 交互に並べる。**枠の並びは chosen の順**（画面の↑↓・外すがそのまま反映される）。
 * 土台の内訳と実物が合わないときは null を返す（画面は理由を出して土台だけ見せる）。
 */
export function buildPreviewPlan(
  missing: readonly MissingAttachment[],
  chosen: ChosenMap,
  layout: readonly PdfLayoutEntry[] | null | undefined,
  basePages: number | null,
): PreviewSegment[] | null {
  if (!layout || basePages === null) return null;
  const totalInLayout = layout.reduce((sum, e) => sum + e.pages, 0);
  if (totalInLayout !== basePages) return null;

  const ranges = baseRanges(layout);
  const out: PreviewSegment[] = [];
  let cursor = 0;
  const pushBase = (from: number, to: number, label: string | null) => {
    if (to > from) out.push({ kind: "base", key: `base:${from}:${to}`, from, to, label });
  };

  for (const m of [...missing].sort((a, b) => a.index - b.index)) {
    const start = startOf(layout, m.index);
    if (start < cursor || start > basePages) return null;
    // 枠より前の部品（本体・添付など）
    pushBase(cursor, start, null);
    const entries = chosen.get(m.index) ?? [];
    if (entries.length === 0 && m.filled) {
      // 入れ直したが結合できなかった書類。PCにはあるが中身は持っていない
      out.push({
        kind: "placeholder",
        key: `filled:${m.index}`,
        index: m.index,
        text: PLACEHOLDER_ON_PC,
      });
    }
    entries.forEach((entry, at) => {
      const key = entryKey(m.index, entry, at);
      if (isKept(entry)) {
        const range = ranges.get(`${m.index}:${entry.kept}`);
        if (range) {
          out.push({
            kind: "base",
            key: `kept:${key}`,
            from: range.from,
            to: range.to,
            label: entry.name,
          });
        } else {
          // 入れただけで、まだ土台のPDFには入っていない書類
          out.push({
            kind: "placeholder",
            key: `kept-ph:${key}`,
            index: m.index,
            entry,
            text: PLACEHOLDER_ON_PC,
          });
        }
        return;
      }
      out.push({ kind: "file", key: `file:${key}`, index: m.index, entry });
    });
    cursor = start + pagesOf(layout, m.index);
    if (cursor > basePages) return null;
  }
  pushBase(cursor, basePages, null);
  return out;
}

/** プレビューのページ数（土台の範囲＋入れる書類。書類のページ数は分からないので1枚と数える） */
export function previewPageCount(
  segments: readonly PreviewSegment[],
  pagesOfFile?: (entry: ChosenFile) => number | null,
): number {
  let total = 0;
  for (const seg of segments) {
    if (seg.kind === "base") total += seg.to - seg.from;
    else if (seg.kind === "placeholder") total += 1;
    else total += pagesOfFile?.(seg.entry) ?? 1;
  }
  return total;
}
