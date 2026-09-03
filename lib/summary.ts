/**
 * 点検内容 / アフター受付内容 (①②…で改行された要約) の扱い。純関数のみ。
 *
 * 本文の持ち方は2通りある:
 * - まとめて1つ: cells[SUMMARY_COL] に全事象が入る (既定)
 * - 工事区分ごとに分ける: categories[k].summary に区分ごとの本文が入り、
 *   Excelへ展開した行ごとに別の本文が貼られる (splitSummary フラグが true のとき)
 */
import { NO_DEFECT_TEXT, formatPhenomena } from "@/lib/summarize/format";
import { SUMMARY_COL } from "@/lib/tsv";
import { findCategoryInText } from "@/lib/work-categories";

const LEADING_NUMBER = /^(?:[①-⑳]|\(\d+\)|\d+[.)、]|・)\s*/;
const NOTE_LINE = /^メモ\s*[:：]\s*/;

/** アフター受付内容を、指示内容の項目と点検員メモに分ける */
export interface SummaryParts {
  /** 指示内容の項目 (先頭の番号は落とす) */
  items: string[];
  /** 点検員メモ (「メモ: 」の接頭辞は落とす) */
  notes: string[];
  /** 元が「不具合の指摘なし」の定型文だったか (項目を空にしたときに戻す) */
  noDefect: boolean;
}

/**
 * アフター受付内容 (①②…で改行された要約) を項目・メモに分ける。
 * 指示内容の編集で書き戻すときに、メモや定型文を失わないようにするため分けて持つ。
 */
export function splitSummary(summary: string): SummaryParts {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items: string[] = [];
  const notes: string[] = [];
  let noDefect = false;
  for (const line of lines) {
    if (NOTE_LINE.test(line)) {
      notes.push(line.replace(NOTE_LINE, "").trim());
    } else if (line === NO_DEFECT_TEXT) {
      noDefect = true;
    } else {
      const text = line.replace(LEADING_NUMBER, "").trim();
      if (text) items.push(text);
    }
  }
  return { items, notes, noDefect };
}

/**
 * アフター受付内容 (①②…で改行された要約) を項目の配列にする。
 * 先頭の番号・点検員メモ・「指摘なし」の定型文は落とす。
 */
export function splitInstructionItems(summary: string): string[] {
  return splitSummary(summary).items;
}

/** 編集した指示内容をアフター受付内容の本文に戻す (メモ・定型文は保つ) */
export function joinSummary(parts: SummaryParts): string {
  const items = parts.items.map((s) => s.trim()).filter(Boolean);
  return formatPhenomena(items, parts.notes, {
    emptyText: parts.noDefect ? NO_DEFECT_TEXT : "",
  });
}

/** ResultRow のうち、点検内容の読み出しに要る部分だけ (テストから最小の入力で呼べるように) */
export interface SummarySplitSource {
  cells: string[];
  categories?: readonly { value: string; summary?: string }[];
  splitSummary?: boolean;
}

/**
 * 点検内容を工事区分ごとに分けて持っているか。
 * フラグが立っていても区分が2件未満なら分ける意味が無いので、まとめて1つとして扱う。
 */
export function isSummarySplit(row: SummarySplitSource): boolean {
  return row.splitSummary === true && (row.categories?.length ?? 0) >= 2;
}

/**
 * 点検内容を工事区分ごとに振り分ける。戻り値は categories と同じ長さ (①②③を振り直した本文)。
 *
 * - 各事象は本文中に現れる区分名・別名 (findCategoryInText) で振り分ける
 * - どれにも当たらない事象は「その他」の行、無ければ先頭の行へ
 * - 点検員メモ・「指摘なし」の定型文は先頭の行にだけ付ける
 * - 同じ区分が2回あれば先頭の方へ入れる。空欄の区分はキーワード一致の対象にしない
 */
export function distributeSummary(summary: string, categories: readonly string[]): string[] {
  const { items, notes, noDefect } = splitSummary(summary);
  const groups: string[][] = categories.map(() => []);
  const firstIndexOf = new Map<string, number>();
  categories.forEach((c, i) => {
    if (c && !firstIndexOf.has(c)) firstIndexOf.set(c, i);
  });
  const fallback = firstIndexOf.get("その他") ?? 0;

  for (const item of items) {
    const hit = findCategoryInText(item, [...firstIndexOf.keys()]);
    const index = hit === null ? fallback : (firstIndexOf.get(hit) ?? fallback);
    groups[index]?.push(item);
  }

  return groups.map((group, i) =>
    formatPhenomena(group, i === 0 ? notes : [], {
      emptyText: i === 0 && noDefect ? NO_DEFECT_TEXT : "",
    }),
  );
}

/**
 * 工事区分ごとに分けて持っている本文を1つにまとめる。
 * 事象は区分の順に並べて①②③を振り直し、メモは重複を除いて末尾に置く。
 */
export function mergeSplitSummary(categories: readonly { summary?: string }[]): string {
  const parts = categories.map((c) => splitSummary(c.summary ?? ""));
  const items = parts.flatMap((p) => p.items);
  const notes = [...new Set(parts.flatMap((p) => p.notes))];
  const noDefect = items.length === 0 && parts.some((p) => p.noDefect);
  return joinSummary({ items, notes, noDefect });
}

/**
 * 記録1件分の点検内容 (メール文・完了報告書に使う)。
 * 分けていなければ cells[SUMMARY_COL] そのまま、分けていれば全区分をまとめたもの。
 */
export function recordSummary(row: SummarySplitSource): string {
  if (!isSummarySplit(row)) return row.cells[SUMMARY_COL] ?? "";
  return mergeSplitSummary(row.categories ?? []);
}
