/**
 * 進捗管理表（アフター・現場対応なし・年次点検）とエンド立会管理表を読む。
 *
 * ★列は位置ではなく**見出しの文字**で探す（列を足し引きされても読めるように）。
 *   見出しは2段（例「新築時」の下に「監督」「営業」、「最終確認」の下に「担当」「日時」）なので、
 *   上の段と下の段をつないだ名前（「最終確認/担当」）でも引けるようにする。
 * ★日付はシリアル値（1900年基準の日数）で持つ。支出報告書にもそのまま書ける。
 */
import type { SheetTable } from "@/lib/after/xlsx-read";
import { type PjParts, parsePj } from "./pj";

export type ProgressSource = "after" | "noSite" | "inspection";

export interface ProgressRow {
  source: ProgressSource;
  /** シートの行番号（1始まり。画面の注意に出す） */
  rowNo: number;
  /**
   * 何番目に選んだファイルの行か（同じ表を複数ファイル選べる。2026-10-03）。
   * ★ファイルの境目をまたいで★の続きにしない・同じ受付が2つのファイルにあれば1つにまとめる、に使う
   */
  fileNo?: number;
  /** ★の行か（物件数の列。★の無い行は直前の★の続き） */
  star: boolean;
  pjText: string;
  pj: PjParts | null;
  receptionType: string;
  receivedAt: number | null;
  staff: string;
  developer: string;
  propertyName: string;
  handoverAt: number | null;
  completedAt: number | null;
  workCategory: string;
  content: string;
  vendor: string;
  action: string;
  updatedAt: number | null;
}

/** ★でまとめた1件（1つの受付）。支出報告書の № 1つ分 */
export interface ProgressCase {
  source: ProgressSource;
  rows: ProgressRow[];
  /** 先頭の行（★の行） */
  head: ProgressRow;
  receivedAt: number | null;
  completedAt: number | null;
}

export interface EndRow {
  rowNo: number;
  pjText: string;
  pj: PjParts | null;
  /** 内覧会日（支出報告書の「アフター工事完了日」に書く） */
  previewAt: number | null;
  /** 決済日（支出報告書の「物件引渡日」に書く） */
  settledAt: number | null;
  /** 最終確認の担当（無ければ「担当」） */
  staff: string;
  propertyName: string;
}

export class SheetFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetFormatError";
  }
}

const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

/** Excel の日付（シリアル値・「2026/8/1」）をシリアル値に。読めなければ null */
export function toSerial(text: string | undefined): number | null {
  const s = (text ?? "").normalize("NFKC").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    return n > 20000 && n < 80000 ? n : null;
  }
  const m = /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/.exec(s);
  if (!m) return null;
  return serialOf(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 年月日 → シリアル値（1900年基準。Excel の 1900/2/29 の誤りを含めた数え方） */
export function serialOf(year: number, month: number, day: number): number {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** シリアル値 → [年, 月, 日] */
export function dateOf(serial: number): [number, number, number] {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

interface Header {
  /** 見出しの行（0始まり） */
  row: number;
  /** 列番号 → 呼び名（上の段 / 上の段/下の段 / 下の段） */
  names: string[][];
}

/** 見出しの行を探す。must の見出しが全部ある最初の行（上から20行まで） */
function findHeader(rows: string[][], must: string[]): Header | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cells = rows[r].map(norm);
    if (!must.every((m) => cells.includes(norm(m)))) continue;
    const below = (rows[r + 1] ?? []).map(norm);
    const names: string[][] = [];
    let lastTop = "";
    const width = Math.max(cells.length, below.length);
    for (let c = 0; c < width; c++) {
      const top = cells[c] ?? "";
      const sub = below[c] ?? "";
      if (top) lastTop = top;
      const group = top || (sub ? lastTop : "");
      const list: string[] = [];
      if (top) list.push(top);
      if (sub) list.push(`${group}/${sub}`, sub);
      names.push(list);
    }
    return { row: r, names };
  }
  return null;
}

function column(header: Header, ...aliases: string[]): number {
  for (const alias of aliases.map(norm)) {
    // 上の段・つないだ名前を先に、下の段だけの名前はあと（「担当」が「最終確認/担当」に当たらないように）
    const exact = header.names.findIndex((list) => list.slice(0, list.length > 1 ? 2 : 1).includes(alias));
    if (exact >= 0) return exact;
  }
  for (const alias of aliases.map(norm)) {
    const loose = header.names.findIndex((list) => list.includes(alias));
    if (loose >= 0) return loose;
  }
  return -1;
}

const cell = (row: string[], col: number) => (col >= 0 ? (row[col] ?? "").trim() : "");

const PROGRESS_LABELS = {
  pj: ["PJ"],
  star: ["物件数"],
  receptionType: ["受付種別"],
  receivedAt: ["受付日"],
  staff: ["担当"],
  developer: ["事業者・EU", "事業者"],
  propertyName: ["物件名称", "物件名"],
  handoverAt: ["引渡日"],
  completedAt: ["完了日"],
  workCategory: ["工事区分"],
  content: ["アフター受付内容", "点検内容", "受付内容"],
  vendor: ["手配業者"],
  action: ["対応内容/処置", "処置"],
  updatedAt: ["対応内容/最終更新日", "最終更新日"],
} as const;

/**
 * 進捗管理表を読む。★見出しに「PJ」「受付日」「完了日」がある、表示されているシートを使う。
 * 見つからなければ SheetFormatError（どのファイルを選んだかを利用者に確かめてもらう）。
 */
export function readProgressSheet(sheets: readonly SheetTable[], source: ProgressSource, label: string): ProgressRow[] {
  for (const sheet of sheets) {
    if (sheet.hidden) continue;
    const header = findHeader(sheet.rows, ["PJ", "受付日", "完了日"]);
    if (!header) continue;
    const col = Object.fromEntries(
      Object.entries(PROGRESS_LABELS).map(([key, aliases]) => [key, column(header, ...aliases)]),
    ) as Record<keyof typeof PROGRESS_LABELS, number>;
    const out: ProgressRow[] = [];
    for (let r = header.row + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      const pjText = cell(row, col.pj);
      const propertyName = cell(row, col.propertyName);
      if (!pjText && !propertyName) continue;
      // 2段目の見出しの行（「監督」「営業」だけの行）は飛ばす
      if (r === header.row + 1 && !toSerial(cell(row, col.receivedAt)) && !pjText) continue;
      out.push({
        source,
        rowNo: r + 1,
        star: cell(row, col.star).includes("★"),
        pjText,
        pj: parsePj(pjText),
        receptionType: cell(row, col.receptionType),
        receivedAt: toSerial(cell(row, col.receivedAt)),
        staff: cell(row, col.staff),
        developer: cell(row, col.developer),
        propertyName,
        handoverAt: toSerial(cell(row, col.handoverAt)),
        completedAt: toSerial(cell(row, col.completedAt)),
        workCategory: cell(row, col.workCategory),
        content: cell(row, col.content),
        vendor: cell(row, col.vendor),
        action: cell(row, col.action),
        updatedAt: toSerial(cell(row, col.updatedAt)),
      });
    }
    return out;
  }
  throw new SheetFormatError(`${label}に「PJ」「受付日」「完了日」の見出しが見つかりません。選んだファイルが合っているか確かめてください`);
}

/**
 * ★の行でまとめる。★の無い行は、直前の★の行と PJ が同じ（または空）なら同じ受付の続き。
 * ★の列が無い表（全部の行に★が無い）は1行ずつ。
 */
export function groupCases(rows: readonly ProgressRow[]): ProgressCase[] {
  const anyStar = rows.some((r) => r.star);
  const cases: ProgressCase[] = [];
  for (const row of rows) {
    const last = cases.at(-1);
    const continues =
      anyStar &&
      !row.star &&
      last !== undefined &&
      last.source === row.source &&
      last.head.fileNo === row.fileNo &&
      (!row.pjText || row.pjText === last.head.pjText);
    if (continues) last.rows.push(row);
    else cases.push({ source: row.source, rows: [row], head: row, receivedAt: null, completedAt: null });
  }
  for (const c of cases) {
    const received = c.rows.map((r) => r.receivedAt).filter((v): v is number => v !== null);
    const completed = c.rows.map((r) => r.completedAt).filter((v): v is number => v !== null);
    c.receivedAt = received.length ? Math.min(...received) : null;
    c.completedAt = completed.length ? Math.max(...completed) : null;
  }
  return cases;
}

/**
 * エンド立会管理表を読む。★「最終確認」の下に「担当」「日時」がある、表示されているシートを使う
 * （同じブックに参照式だけの集計シートや前の期のシートがあるため）。
 */
export function readEndSheet(sheets: readonly SheetTable[]): EndRow[] {
  for (const sheet of sheets) {
    if (sheet.hidden) continue;
    const header = findHeader(sheet.rows, ["PJ", "内覧会日", "決済日", "最終確認"]);
    if (!header) continue;
    const col = {
      pj: column(header, "PJ"),
      previewAt: column(header, "内覧会日"),
      settledAt: column(header, "決済日"),
      finalStaff: column(header, "最終確認/担当"),
      staff: column(header, "担当"),
      propertyName: column(header, "物件名称", "物件名"),
    };
    const out: EndRow[] = [];
    for (let r = header.row + 2; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      const pjText = cell(row, col.pj);
      const propertyName = cell(row, col.propertyName);
      if (!pjText && !propertyName) continue;
      out.push({
        rowNo: r + 1,
        pjText,
        pj: parsePj(pjText),
        previewAt: toSerial(cell(row, col.previewAt)),
        settledAt: toSerial(cell(row, col.settledAt)),
        staff: cell(row, col.finalStaff) || cell(row, col.staff),
        propertyName,
      });
    }
    return out;
  }
  throw new SheetFormatError("エンド立会管理表に「内覧会日」「決済日」「最終確認」の見出しが見つかりません。選んだファイルが合っているか確かめてください");
}
