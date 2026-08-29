/**
 * 完了報告書のPDFを組み立てる (ブラウザ内で pdf-lib を使う)。
 * 見た目は見本PDF (完了報告書_例/*.pdf) に合わせてある。
 * 座標計算は lib/report/layout/grid.ts が行い、ここでは描画だけを担当する。
 */
import {
  PDFDocument,
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import {
  APPENDIX_ROWS_PER_PAGE,
  appendixSheet,
  paginateAppendixItems,
} from "@/lib/report/layout/appendix-sheet";
import { resolveGeometry, type Geometry, type SheetSpec } from "@/lib/report/layout/grid";
import { MAIN_SHEET } from "@/lib/report/layout/main-sheet";
import { PAGE_HEIGHT, PAGE_WIDTH } from "@/lib/report/metrics";
import type { ReportData } from "@/lib/report/model";
import { codePointsOf, subsetFont } from "@/lib/report/subset";

export interface ReportFonts {
  regular: Uint8Array;
  bold: Uint8Array;
  /** .ttc を渡す場合、使う書体の位置 (省略時は0) */
  regularFaceIndex?: number;
  boldFaceIndex?: number;
}

/** 埋め込みフォントに無い文字の代わりに出す字 (下駄記号) */
const MISSING_GLYPH = "〓";

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);

/** 文字列を描画前に整える (合成文字・制御文字・特殊な空白を落とす) */
export function sanitizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/ /g, " ")
    // 異体字セレクタ (𠮷󠄀 のような組み合わせ) はフォントに無いので落とす
    .replace(/[︀-️]|\udb40[\udd00-\uddef]/g, "");
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  const n = Number.parseInt(value, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** #RRGGBB → pdf-lib の色。y は上向きに直す */
const flipY = (y: number) => PAGE_HEIGHT - y;

/** 角丸四角のSVGパス (原点は左上、y下向き) */
function roundedRectPath(size: number, radius: number): string {
  const r = Math.min(radius, size / 2);
  return [
    `M ${r} 0`,
    `L ${size - r} 0`,
    `Q ${size} 0 ${size} ${r}`,
    `L ${size} ${size - r}`,
    `Q ${size} ${size} ${size - r} ${size}`,
    `L ${r} ${size}`,
    `Q 0 ${size} 0 ${size - r}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    "Z",
  ].join(" ");
}

/** チェック記号のSVGパス (箱の大きさに対する相対座標) */
function checkPath(size: number): string {
  const p = (fx: number, fy: number) => `${(fx * size).toFixed(3)} ${(fy * size).toFixed(3)}`;
  return `M ${p(0.254, 0.521)} L ${p(0.399, 0.666)} L ${p(0.765, 0.299)}`;
}

class Painter {
  private readonly missing = new Set<string>();

  constructor(
    private readonly page: PDFPage,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly charset: { regular: Set<number>; bold: Set<number> },
  ) {}

  /** フォントに無い文字を下駄記号に置き換える */
  private replaceMissing(text: string, set: Set<number>): string {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && !set.has(cp)) {
        this.missing.add(ch);
        out += MISSING_GLYPH;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /**
   * 描くフォントを決める。太字フォントは収録文字を絞ってあるので、
   * そこに無い字 (例: 受付種別「半年」の「半」) が来たら通常フォントを二重描きして太字風にする。
   */
  private resolve(text: string, bold: boolean): { font: PDFFont; body: string; fake: boolean } {
    if (!bold) {
      return { font: this.regular, body: this.replaceMissing(text, this.charset.regular), fake: false };
    }
    const covered = [...text].every((ch) => this.charset.bold.has(ch.codePointAt(0) ?? -1));
    if (covered) return { font: this.bold, body: text, fake: false };
    return { font: this.regular, body: this.replaceMissing(text, this.charset.regular), fake: true };
  }

  missingCharacters(): string[] {
    return [...this.missing];
  }

  paint(geometry: Geometry): void {
    for (const fill of geometry.fills) {
      this.page.drawRectangle({
        x: fill.x0,
        y: flipY(fill.y1),
        width: fill.x1 - fill.x0,
        height: fill.y1 - fill.y0,
        color: fill.color ? hexToRgb(fill.color) : BLACK,
      });
    }
    // 罫線は塗り矩形として描く (見本PDFと同じ。細い線でも太さが安定する)
    for (const line of geometry.lines) {
      const half = line.width / 2;
      const horizontal = line.y0 === line.y1;
      const x = horizontal ? line.x0 : line.x0 - half;
      const width = horizontal ? line.x1 - line.x0 : line.width;
      const top = horizontal ? line.y0 - half : line.y0;
      const height = horizontal ? line.width : line.y1 - line.y0;
      this.page.drawRectangle({ x, y: flipY(top + height), width, height, color: BLACK });
    }
    for (const rect of geometry.underlines) {
      this.page.drawRectangle({
        x: rect.x0,
        y: flipY(rect.y1),
        width: rect.x1 - rect.x0,
        height: rect.y1 - rect.y0,
        color: BLACK,
      });
    }
    for (const text of geometry.texts) {
      const { font, body, fake } = this.resolve(text.text, text.bold);
      if (text.clip) {
        // 縮小しても収まらない文字は、セルの外に出た分を隠す
        const { x0, y0, x1, y1 } = text.clip;
        this.page.pushOperators(
          pushGraphicsState(),
          moveTo(x0, flipY(y0)),
          lineTo(x1, flipY(y0)),
          lineTo(x1, flipY(y1)),
          lineTo(x0, flipY(y1)),
          closePath(),
          clip(),
          endPath(),
        );
      }
      const y = flipY(text.baseline);
      this.page.drawText(body, { x: text.x, y, size: text.size, font });
      // 太字フォントを使えなかった分は、少しずらして重ね描きして太さを出す
      if (fake) this.page.drawText(body, { x: text.x + text.size * 0.028, y, size: text.size, font });
      if (text.clip) this.page.pushOperators(popGraphicsState());
    }
    for (const box of geometry.checkboxes) {
      const path = roundedRectPath(box.size, box.size * 0.14);
      this.page.drawSvgPath(path, {
        x: box.x,
        y: flipY(box.y),
        color: box.checked ? BLACK : undefined,
        borderColor: BLACK,
        borderWidth: box.checked ? 0 : box.size * 0.109,
      });
      if (box.checked) {
        this.page.drawSvgPath(checkPath(box.size), {
          x: box.x,
          y: flipY(box.y),
          borderColor: WHITE,
          borderWidth: box.size * 0.145,
          borderLineCap: 1,
        });
      }
    }
  }
}

/** この報告書で使う文字をすべて集める (フォントを必要な文字だけに絞るため) */
function reportTexts(data: ReportData, values: Record<string, string>): string[] {
  const texts = [...Object.values(values), MISSING_GLYPH];
  for (const cell of MAIN_SHEET.cells) if (cell.text) texts.push(cell.text);
  if (MAIN_SHEET.header) texts.push(MAIN_SHEET.header.text);
  if (data.appendix) {
    const pages = paginateAppendixItems(data.appendix.items);
    pages.forEach((items, index) => {
      const { spec, values: appendixValues } = appendixSheet({
        title: data.appendix!.title,
        propertyLine: data.appendix!.propertyLine,
        ownerLine: data.appendix!.ownerLine,
        items,
        pageLabel: appendixPageLabel(index, pages.length),
      });
      for (const cell of spec.cells) if (cell.text) texts.push(cell.text);
      texts.push(...Object.values(appendixValues));
    });
  }
  return texts.map(sanitizeText);
}

/** 本紙に差し込む値 */
function mainValues(data: ReportData): Record<string, string> {
  const values: Record<string, string> = {
    pj: data.pj,
    handoverDate: data.handoverDate,
    propertyName: data.propertyName,
    // Excelの表示形式 (@\ "様") が付ける「 様」を再現する
    ownerLine: data.ownerLine ? `${data.ownerLine} 様` : "",
    address: data.address,
    phone1: data.phone1,
    phone2: data.phone2,
    receptionDate: data.receptionDate,
    receptionist: data.receptionist,
  };
  data.main.forEach((slot, i) => {
    values[`no${i}`] = slot.no;
    values[`item${i}`] = slot.text;
  });
  return values;
}

/** 立会・受付項目のチェック状態 (完了チェックは常に未チェック) */
function mainFlags(data: ReportData): Record<string, boolean> {
  return {
    "attendance.owner": data.options.attendance.owner,
    "attendance.family": data.options.attendance.family,
    "attendance.other": data.options.attendance.other,
    "categories.inspection": data.options.categories.inspection,
    "categories.after": data.options.categories.after,
    "categories.paid": data.options.categories.paid,
    "categories.direct": data.options.categories.direct,
    "categories.free": data.options.categories.free,
  };
}

/** 別紙のページ番号表示 (2ページ構成なら「2/2」) */
export function appendixPageLabel(pageIndex: number, appendixPages: number): string {
  return `${pageIndex + 2}/${appendixPages + 1}`;
}

export interface ReportPdfResult {
  bytes: Uint8Array;
  warnings: string[];
}

export async function buildReportPdf(data: ReportData, fonts: ReportFonts): Promise<ReportPdfResult> {
  const fontkit = await import("@pdf-lib/fontkit").then((m) => m.default ?? m);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit as never);

  // この文書で使う文字だけにフォントを絞ってから埋め込む。
  // pdf-lib (fontkit) のサブセット化は字形数の多い日本語フォントで字形が欠けるため使えないので、
  // HarfBuzz (hb-subset) で先に小さくし、pdf-lib には subset:false で渡す。
  // .ttc (游ゴシック等) から1書体を取り出すのもここで行う。
  const values = mainValues(data);
  const used = codePointsOf(reportTexts(data, values));
  const [regularBytes, boldBytes] = await Promise.all([
    subsetFont(fonts.regular, used, { faceIndex: fonts.regularFaceIndex }),
    subsetFont(fonts.bold, used, { faceIndex: fonts.boldFaceIndex }),
  ]);
  const regular = await doc.embedFont(regularBytes, { subset: false });
  const bold = await doc.embedFont(boldBytes, { subset: false });
  const charset = {
    regular: new Set(regular.getCharacterSet()),
    bold: new Set(bold.getCharacterSet()),
  };
  doc.setTitle("完了報告書");
  doc.setProducer("Folio");
  doc.setCreator("Folio");

  const warnings: string[] = [];
  const missing = new Set<string>();
  const overflow = new Set<string>();

  const measure = (text: string, size: number, isBold: boolean) =>
    (isBold ? bold : regular).widthOfTextAtSize(sanitizeText(text), size);

  const render = (spec: SheetSpec, values: Record<string, string>, flags: Record<string, boolean>) => {
    const sanitized = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, sanitizeText(v)]),
    );
    const geometry = resolveGeometry(spec, sanitized, flags, measure);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const painter = new Painter(page, regular, bold, charset);
    painter.paint(geometry);
    for (const ch of painter.missingCharacters()) missing.add(ch);
    for (const ref of geometry.overflow) overflow.add(ref);
  };

  render(MAIN_SHEET, values, mainFlags(data));

  if (data.appendix) {
    const pages = paginateAppendixItems(data.appendix.items);
    pages.forEach((items, index) => {
      const { spec, values } = appendixSheet({
        title: data.appendix!.title,
        propertyLine: data.appendix!.propertyLine,
        ownerLine: data.appendix!.ownerLine,
        items,
        pageLabel: appendixPageLabel(index, pages.length),
      });
      render(spec, values, {});
    });
    if (data.appendix.items.length > APPENDIX_ROWS_PER_PAGE) {
      warnings.push(
        `指示内容が${data.appendix.items.length}件あるため、PDFの別紙を${pages.length}ページに分けました`,
      );
    }
  }

  if (missing.size > 0) {
    warnings.push(
      `PDFのフォントに無い文字を「${MISSING_GLYPH}」に置き換えました: ${[...missing].join("")}`,
    );
  }
  if (overflow.size > 0) {
    warnings.push(`文字数が多く枠に収まらない欄があります (${[...overflow].join(", ")})`);
  }

  return { bytes: await doc.save(), warnings };
}
