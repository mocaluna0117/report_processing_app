/**
 * 「Excelのシート」を宣言的に書いた仕様 (SheetSpec) から、PDFに描く図形の座標を組み立てる。
 * ここでは pdf-lib に依存せず、座標計算だけを行う (テストしやすくするため)。
 * 座標は pt・左上原点 (y は下向き)。
 */
import {
  BASELINE_BORDER_LIFT,
  BASELINE_CENTER_RATIO,
  BASELINE_FROM_BOTTOM,
  CHECKBOX,
  COL_CHAR_UNIT,
  DOUBLE_GAP,
  LINE_WIDTH,
  MIN_FONT_SIZE,
  PAD_LEFT,
  PAD_RIGHT,
  PRINT_FACTOR,
  quantizeFontSize,
} from "@/lib/report/metrics";

export type BorderStyle = "thin" | "medium" | "double" | "hair";
export type HAlign = "left" | "center" | "right";
export type VAlign = "bottom" | "center";
export type Sides = Partial<Record<"l" | "r" | "t" | "b", BorderStyle>>;

export interface CellSpec {
  /** "B5" または結合範囲 "C16:U16" */
  ref: string;
  /** 固定文字列 */
  text?: string;
  /** 差し込む値のキー (values から取る) */
  field?: string;
  /** チェックボックスのキー (flags から取る) */
  checkbox?: string;
  /** 文字サイズ (pt, 縮小前)。既定 11 */
  size?: number;
  bold?: boolean;
  /** 二重下線 (会社名・作業者・お客様ご署名の欄) */
  underline?: boolean;
  h?: HAlign;
  v?: VAlign;
  border?: Sides;
  /** 塗り (#RRGGBB) */
  fill?: string;
  /** 幅に収まらないとき縮小するか */
  shrink?: boolean;
  /**
   * はみ出した文字をセルの中で切る。
   * Excelは隣のセルが埋まっているとはみ出し分を表示しないので、それを再現する
   * (例: 32行目の「　　年　　　月　　　日」は、左隣に「年」「月」があるため
   *  U列に収まる「日」しか出ない)。
   */
  clipToCell?: boolean;
}

export interface SheetSpec {
  scale: number;
  x0: number;
  y0: number;
  /** colChars の先頭に対応する列 (本紙はA列が非表示なので "B"、別紙は "A") */
  originColumn: string;
  /** 各列のExcel列幅 (文字数) */
  colChars: readonly number[];
  /** 各行の行高 (pt) */
  rowHeights: readonly number[];
  cells: readonly CellSpec[];
  /** ページヘッダー (印刷時に出るシート名) */
  header?: { text: string; size: number; x: number; baseline: number };
}

export interface LineDraw {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  style: BorderStyle;
}
export interface RectDraw {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color?: string;
}
export interface TextDraw {
  text: string;
  x: number;
  baseline: number;
  size: number;
  bold: boolean;
  /** はみ出す文字を隠すための切り抜き範囲 */
  clip?: RectDraw;
}
export interface CheckboxDraw {
  x: number;
  y: number;
  size: number;
  checked: boolean;
}
export interface Geometry {
  fills: RectDraw[];
  lines: LineDraw[];
  texts: TextDraw[];
  underlines: RectDraw[];
  checkboxes: CheckboxDraw[];
  /** 縮小しても収まらなかったセル (呼び出し側で警告に使う) */
  overflow: string[];
}

/** 文字幅を測る関数 (pdf-lib のフォントを包んで渡す) */
export type Measure = (text: string, size: number, bold: boolean) => number;

const COLUMN_RE = /^([A-Z]+)(\d+)$/;

/** "A" → 1, "B" → 2 … Excelの列番号 */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

interface Box {
  col0: number;
  col1: number;
  row0: number;
  row1: number;
}

/** "C16:U16" / "B5" を 0始まりの列・行範囲にする (列は originColumn を0とする) */
export function parseRef(ref: string, originColumn = "B"): Box {
  const [from, to] = ref.split(":");
  const a = COLUMN_RE.exec(from);
  if (!a) throw new Error(`セル参照が不正です: ${ref}`);
  const b = to ? COLUMN_RE.exec(to) : a;
  if (!b) throw new Error(`セル参照が不正です: ${ref}`);
  const origin = columnNumber(originColumn);
  return {
    col0: columnNumber(a[1]) - origin,
    col1: columnNumber(b[1]) - origin,
    row0: Number(a[2]) - 1,
    row1: Number(b[2]) - 1,
  };
}

/** 罫線の重なりを1本にまとめる。太い線・二重線を優先する */
const PRIORITY: Record<BorderStyle, number> = { double: 4, medium: 3, thin: 2, hair: 1 };

class EdgeMap {
  private edges = new Map<string, { style: BorderStyle; from: number; to: number }>();

  add(horizontal: boolean, position: number, from: number, to: number, style: BorderStyle): void {
    const key = `${horizontal ? "h" : "v"}:${position.toFixed(2)}:${from.toFixed(2)}:${to.toFixed(2)}`;
    const current = this.edges.get(key);
    if (!current || PRIORITY[style] > PRIORITY[current.style]) {
      this.edges.set(key, { style, from, to });
    }
  }

  /** 同じ線上で連続・重複する区間をつなげる */
  entries(): { horizontal: boolean; position: number; from: number; to: number; style: BorderStyle }[] {
    const grouped = new Map<string, { position: number; horizontal: boolean; style: BorderStyle; spans: [number, number][] }>();
    for (const [key, value] of this.edges) {
      const [dir, pos] = key.split(":");
      const groupKey = `${dir}:${pos}:${value.style}`;
      const group = grouped.get(groupKey) ?? {
        position: Number(pos),
        horizontal: dir === "h",
        style: value.style,
        spans: [],
      };
      group.spans.push([value.from, value.to]);
      grouped.set(groupKey, group);
    }
    const out: { horizontal: boolean; position: number; from: number; to: number; style: BorderStyle }[] = [];
    for (const group of grouped.values()) {
      const spans = group.spans.sort((a, b) => a[0] - b[0]);
      let [start, end] = spans[0];
      for (const [s, e] of spans.slice(1)) {
        if (s <= end + 0.01) {
          end = Math.max(end, e);
        } else {
          out.push({ ...group, from: start, to: end });
          [start, end] = [s, e];
        }
      }
      out.push({ ...group, from: start, to: end });
    }
    return out;
  }
}

export function resolveGeometry(
  spec: SheetSpec,
  values: Record<string, string>,
  flags: Record<string, boolean>,
  measure: Measure,
): Geometry {
  const { scale } = spec;
  // 列の境界と行の境界 (罫線の中心)
  const colX: number[] = [spec.x0];
  for (const chars of spec.colChars) {
    colX.push(colX[colX.length - 1] + chars * COL_CHAR_UNIT * PRINT_FACTOR * scale);
  }
  const rowY: number[] = [spec.y0];
  for (const height of spec.rowHeights) {
    rowY.push(rowY[rowY.length - 1] + height * PRINT_FACTOR * scale);
  }

  // 下寄せ文字のベースラインは「その行の下罫線の太さ」で少し上がる。
  // 罫線はセル単位で書いてあるので、先に行ごとの一番太い下罫線を集めておく。
  const rowBottomBorder = new Map<number, BorderStyle>();
  for (const cell of spec.cells) {
    const style = cell.border?.b;
    if (!style) continue;
    const row = parseRef(cell.ref, spec.originColumn).row1;
    const current = rowBottomBorder.get(row);
    if (!current || PRIORITY[style] > PRIORITY[current]) rowBottomBorder.set(row, style);
  }

  const fills: RectDraw[] = [];
  const texts: TextDraw[] = [];
  const underlines: RectDraw[] = [];
  const checkboxes: CheckboxDraw[] = [];
  const overflow: string[] = [];
  const edges = new EdgeMap();

  const lineWidth = (style: BorderStyle) => LINE_WIDTH[style] * scale;

  for (const cell of spec.cells) {
    const box = parseRef(cell.ref, spec.originColumn);
    const left = colX[box.col0];
    const right = colX[box.col1 + 1];
    const top = rowY[box.row0];
    const bottom = rowY[box.row1 + 1];
    if ([left, right, top, bottom].some((v) => v === undefined)) {
      throw new Error(`セル ${cell.ref} がシートの範囲外です`);
    }

    if (cell.fill) fills.push({ x0: left, y0: top, x1: right, y1: bottom, color: cell.fill });

    if (cell.border) {
      const { l, r, t, b } = cell.border;
      if (t) edges.add(true, top, left, right, t);
      if (b) edges.add(true, bottom, left, right, b);
      if (l) edges.add(false, left, top, bottom, l);
      if (r) edges.add(false, right, top, bottom, r);
    }

    const raw = cell.text ?? (cell.field ? values[cell.field] : undefined);
    if (cell.checkbox !== undefined) {
      const checked = Boolean(flags[cell.checkbox]);
      const size = CHECKBOX.size * scale;
      if (cell.v === "center") {
        // 完了チェック欄: セルの中央に置く
        const centerX = (left + right) / 2 - CHECKBOX.centerShift * scale;
        const centerY = (top + bottom) / 2 + CHECKBOX.centerOffset * scale;
        checkboxes.push({ x: centerX - size / 2, y: centerY - size / 2, size, checked });
      } else {
        // 立会・受付項目: 右寄せセルの右端に寄せ、行の下端からの位置で置く
        const x = right - (CHECKBOX.rightInset + CHECKBOX.size) * scale;
        const y = bottom - CHECKBOX.baselineFromBottom * scale - size;
        checkboxes.push({ x, y, size, checked });
      }
      continue;
    }

    if (!raw) continue;

    const baseSize = quantizeFontSize((cell.size ?? 11) * scale);
    const usable = right - left - (PAD_LEFT + PAD_RIGHT) * scale;
    let size = baseSize;
    let width = measure(raw, size, Boolean(cell.bold));
    if (cell.shrink && width > usable && width > 0) {
      size = Math.max(MIN_FONT_SIZE * scale, quantizeFontSize((size * usable) / width));
      width = measure(raw, size, Boolean(cell.bold));
    }
    const clipped = width > usable + 0.5;
    if (clipped && cell.shrink) overflow.push(cell.ref);
    const clipToCell = cell.clipToCell === true || (clipped && cell.shrink === true);

    const bottomBorder = rowBottomBorder.get(box.row1);
    const baseline =
      cell.v === "center"
        ? (top + bottom) / 2 + size * BASELINE_CENTER_RATIO
        : bottom -
          (BASELINE_FROM_BOTTOM +
            (bottomBorder === "medium" || bottomBorder === "double" ? BASELINE_BORDER_LIFT : 0)) *
            scale;

    const align = cell.h ?? "left";
    const x =
      align === "left"
        ? left + PAD_LEFT * scale
        : align === "right"
          ? right - PAD_RIGHT * scale - width
          : (left + right) / 2 - width / 2;

    texts.push({
      text: raw,
      x,
      baseline,
      size,
      bold: Boolean(cell.bold),
      // はみ出した分をセルの中で切る (縮小しても収まらない場合と、Excelが切る欄)
      clip: clipToCell ? { x0: left, y0: top, x1: right, y1: bottom } : undefined,
    });

    if (cell.underline) {
      // 二重下線。線の太さと位置は見本PDFの実測値
      for (const offset of [1.18, 2.38]) {
        underlines.push({
          x0: x,
          y0: baseline + offset * scale,
          x1: x + width,
          y1: baseline + (offset + 0.6) * scale,
        });
      }
    }
  }

  if (spec.header) {
    texts.push({
      text: spec.header.text,
      x: spec.header.x,
      baseline: spec.header.baseline,
      size: spec.header.size,
      bold: true,
    });
  }

  // 罫線は塗り矩形として描く。見本PDFと同じく、線の両端は太さの半分だけずらす
  const lines: LineDraw[] = [];
  for (const edge of edges.entries()) {
    const w = lineWidth(edge.style);
    const half = w / 2;
    const positions =
      edge.style === "double" ? [edge.position - DOUBLE_GAP * scale / 2, edge.position + DOUBLE_GAP * scale / 2] : [edge.position];
    for (const position of positions) {
      if (edge.horizontal) {
        // 二重線だけ右端の扱いが違う (見本PDFの実測に合わせる)
        const x1 = edge.style === "double" ? edge.to - half : edge.to + half;
        lines.push({ x0: edge.from + half, y0: position, x1, y1: position, width: w, style: edge.style });
      } else {
        lines.push({
          x0: position,
          y0: edge.from - half,
          x1: position,
          y1: edge.to + half,
          width: w,
          style: edge.style,
        });
      }
    }
  }

  return { fills, lines, texts, underlines, checkboxes, overflow };
}
