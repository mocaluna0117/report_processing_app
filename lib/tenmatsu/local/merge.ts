/**
 * 部品（本体PDFと添付）を1つの PDF にまとめる。
 *
 * 移植元: tenmatsu.py 1473-1586（merge_to_pdf）
 *
 * - PDF はそのまま、JPEG / PNG は1ページの PDF にして差し込む
 * - ★動画・音声は紙にできないので**結合せずに飛ばす**（止めない）。飛ばした名前は必ず返す
 * - ★Excel・Word・PowerPoint・メールは**変換しない**（2026-09-13 の決定）。「手で PDF にしてから入れてください」
 *   として結合できなかった扱いにし、保留にして手で入れられるようにする（黙って飛ばさない）
 * - ★ページ数の配列は**部品と同じ順・同じ長さ**を必ず保つ（飛ばした動画も失敗した添付も 0）。
 *   ずれると「PDFのどのページが誰のものか」が恒久的に作れなくなる
 * - ★空の PDF は作らない
 * - ★**開くのにパスワードは要らないが保護のかかった PDF**（スキャナや銀行などが出すもの）は、保護を解いて結合する。
 *   移植元の pypdf は空のパスワードで自動的に解いていた。pdf-lib（本家）は解けず、無理に読むと**文字の無い白紙**になる
 *   （2026-09-13 に確かめた）。そのため結合には保護を解ける `@cantoo/pdf-lib`（pdf-lib の改良版）を使う。
 *   本当にパスワードが要る PDF は解けないので、理由を添えて結合できなかった扱いにする。
 */
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { EXCEL_EXTS, IMAGE_EXTS, MEDIA_EXTS, MSG_EXTS, PDF_EXTS, PPT_EXTS, TEXT_EXTS, WORD_EXTS, extOf, looksLikeHtml } from "@/lib/rakuraku/parse/sniff";
import { imageToPdfBytes } from "./image";

export interface MergePart {
  /** フォルダーの中の名前（拡張子で形式を決める。拡張子は受け取ったときに中身で直してある） */
  name: string;
  bytes: Uint8Array;
}

export interface MergeOptions {
  /**
   * 結合できなかった部品を集めて先へ進むか（保留にするため）。偽なら最初の失敗で例外。
   */
  collectFailures?: boolean;
  /**
   * 先頭（本体）の失敗だけは集めずに例外にするか（既定 true）。
   * ★捺印決裁書は先頭が本体ではない（あとから入れる書類）ので false にする。
   */
  strictFirst?: boolean;
}

export interface MergeOutcome {
  bytes: Uint8Array;
  totalPages: number;
  /** 部品と同じ順・同じ長さ。その部品が入れたページ数 */
  pageCounts: number[];
  /** 動画・音声のため飛ばした部品の名前 */
  skipped: string[];
  /** 結合できなかった部品（collectFailures のときだけ入る） */
  failed: { name: string; reason: string }[];
}

/** Office などの添付を変換しないことにした理由。画面にもこの文を出す */
export const OFFICE_NOT_CONVERTED =
  "Excel・Word・PowerPoint・メールの添付は結合できません。手でPDFにしてから入れてください";

/** 結合できる形式の説明 */
export const SUPPORTED_ATTACHMENT_TEXT = "PDF, JPG, JPEG, PNG";

/** 手で入れられる形式（結合できるものだけ） */
export const UPLOADABLE_EXTS: ReadonlySet<string> = new Set([...PDF_EXTS, ...IMAGE_EXTS]);

const isEncryptedError = (e: unknown) => e instanceof Error && /encrypt/i.test(`${e.name} ${e.message}`);

async function loadPdf(part: MergePart): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(part.bytes, { updateMetadata: false });
  } catch (e) {
    if (!isEncryptedError(e)) throw e;
  }
  try {
    // 空のパスワードで開ける保護は解く（移植元の pypdf と同じ）。★ignoreEncryption では読まない（白紙になる）
    return await PDFDocument.load(part.bytes, { updateMetadata: false, password: "" });
  } catch (e) {
    if (e instanceof Error && /password/i.test(e.message)) {
      throw new Error(`パスワードが必要なPDFのため結合できません: ${part.name}。パスワードを外したPDFを入れてください`);
    }
    throw e;
  }
}

/** PDF のページ数。読めなければ null（★黙って 0 にしない）。保護は解いて数える */
export async function countPdfPages(bytes: Uint8Array): Promise<number | null> {
  try {
    return (await loadPdf({ name: "", bytes })).getPageCount();
  } catch {
    return null;
  }
}

async function addPdf(out: PDFDocument, part: MergePart): Promise<void> {
  let src: PDFDocument;
  try {
    src = await loadPdf(part);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("パスワードが必要なPDF")) throw e;
    const hint = looksLikeHtml(part.bytes)
      ? "中身がPDFではなくHTMLです。ログインが切れてログイン画面が返された、またはエラーページが保存された可能性があります。"
      : "";
    throw new Error(`PDFとして読めませんでした: ${part.name}（${part.bytes.length.toLocaleString("ja-JP")}バイト）。${hint}`);
  }
  const copied = await out.copyPages(src, src.getPageIndices());
  const pages = src.getPages();
  copied.forEach((page, i) => {
    // copyPages は通常 /Rotate を保つが、継承された値の取りこぼしに備えて明示する（lib/pdf/merge.ts と同じ）
    page.setRotation(degrees(pages[i].getRotation().angle));
    out.addPage(page);
  });
}

async function addPart(out: PDFDocument, part: MergePart, skipped: string[]): Promise<void> {
  const ext = extOf(part.name);
  if (MEDIA_EXTS.has(ext)) {
    skipped.push(part.name);
    return;
  }
  if (PDF_EXTS.has(ext)) {
    await addPdf(out, part);
    return;
  }
  if (IMAGE_EXTS.has(ext)) {
    await addPdf(out, { name: part.name, bytes: await imageToPdfBytes(part.bytes, part.name) });
    return;
  }
  if (EXCEL_EXTS.has(ext) || WORD_EXTS.has(ext) || PPT_EXTS.has(ext) || MSG_EXTS.has(ext) || TEXT_EXTS.has(ext)) {
    throw new Error(`${OFFICE_NOT_CONVERTED}（${part.name}）`);
  }
  throw new Error(`未対応の添付形式です: ${part.name}（対応: ${SUPPORTED_ATTACHMENT_TEXT}／動画・音声は結合せず飛ばします）`);
}

export async function mergeParts(parts: readonly MergePart[], options: MergeOptions = {}): Promise<MergeOutcome> {
  if (parts.length === 0) throw new Error("結合対象が空です");
  const strictFirst = options.strictFirst ?? true;
  const out = await PDFDocument.create();
  const skipped: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  const pageCounts: number[] = [];

  for (const [i, part] of parts.entries()) {
    const before = out.getPageCount();
    try {
      await addPart(out, part, skipped);
    } catch (e) {
      // ★本体（先頭）が読めないときと、集める指定が無いときは止める。
      //   添付だけなら、結合できたところまでで保留にして次の伝票へ進める
      if (!options.collectFailures || (strictFirst && i === 0)) throw e;
      // 途中までページを足してから失敗した場合に備えて、その部品のページを取り除く
      while (out.getPageCount() > before) out.removePage(out.getPageCount() - 1);
      failed.push({ name: part.name, reason: e instanceof Error ? e.message : String(e) });
    }
    // 成否にかかわらず1件につき1つ入れる（部品と同じ長さを保つ）
    pageCounts.push(out.getPageCount() - before);
  }

  const totalPages = out.getPageCount();
  if (totalPages === 0) {
    throw new Error(`結合できるファイルがありませんでした${skipped.length > 0 ? `（飛ばした添付: ${skipped.join(", ")}）` : ""}`);
  }
  return { bytes: await out.save(), totalPages, pageCounts, skipped, failed };
}
