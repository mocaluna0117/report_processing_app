/**
 * 点検内容 / アフター受付内容 (①②…で改行された要約) の扱い。純関数のみ。
 *
 * 本文の持ち方は工事区分の数で決まる (切り替えのボタンは無い):
 * - 工事区分が1件以下: cells[SUMMARY_COL] に全事象が入る
 * - 2件以上: categories[k].summary に区分ごとの本文が入り、Excelへ展開した行ごとに別の本文が貼られる。
 *   cells[SUMMARY_COL] は各行の本文をまとめた「鏡」に保つ (隠れた原本を作らないため)
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
}

/**
 * 点検内容を工事区分ごとに分けて持っているか。
 * 切り替えは無く、工事区分が2件以上あれば常に分ける (1件以下は分ける意味が無い)。
 */
export function isSummarySplit(row: SummarySplitSource): boolean {
  return (row.categories?.length ?? 0) >= 2;
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

/** 各区分から本文を外す (工事区分が1件以下になったとき。共通のセルが唯一の本文になる) */
export function withoutSummaries<C extends { summary?: string }>(categories: readonly C[]): C[] {
  return categories.map((c) => {
    const next = { ...c };
    delete next.summary;
    return next;
  });
}

/**
 * 工事区分が2件以上なら本文をキーワードで振り分けて各区分に付ける。
 * 1件以下なら分けないので、残っていた本文は外す。
 */
export function withDistributedSummaries<C extends { value: string; summary?: string }>(
  categories: readonly C[],
  summary: string,
): (C & { summary?: string })[] {
  if (categories.length < 2) return withoutSummaries(categories);
  const texts = distributeSummary(summary, categories.map((c) => c.value));
  return categories.map((c, i) => ({ ...c, summary: texts[i] ?? "" }));
}

/**
 * 共通のセル (cells[SUMMARY_COL]) を、各区分の本文をまとめた「鏡」に揃える。
 * 分けている間に古い本文がセルに隠れて残ると、メール文・完了報告書・学習・貼り付けが食い違うため。
 * 2件未満なら分けていないので触らない (同じ配列を返す)。
 */
export function syncSummaryCell(
  cells: string[],
  categories: readonly { summary?: string }[],
): string[] {
  if (categories.length < 2) return cells;
  const merged = mergeSplitSummary(categories);
  if (cells[SUMMARY_COL] === merged) return cells;
  return cells.map((c, i) => (i === SUMMARY_COL ? merged : c));
}

/**
 * 共通のセルの本文を区分ごとに振り分けて各行に持たせ、共通のセルはその鏡にする。
 * 処理直後 (processPair)・区分が1件→2件になった編集・古い保存データの読み込みが
 * 同じ手順を踏むよう、1か所にまとめている。
 */
export function attachSummaries<C extends { value: string; summary?: string }>(
  cells: string[],
  categories: readonly C[],
): { cells: string[]; categories: (C & { summary?: string })[] } {
  const next = withDistributedSummaries(categories, cells[SUMMARY_COL] ?? "");
  return { cells: syncSummaryCell(cells, next), categories: next };
}

/** 完了報告書ダイアログの指示内容1グループ (工事区分1件分) */
export interface CategoryItemGroup {
  /** 書き戻し先 (categories の添字) */
  catIndex: number;
  category: string;
  parts: SummaryParts;
}

/**
 * 分けている本文を区分ごとの項目・メモに分ける (完了報告書ダイアログの編集用)。
 * 並びは mergeSplitSummary と同じ区分順なので、①②③を通しで振れば報告書の番号と一致する。
 * 1グループを書き戻すときは joinSummary({ ...group.parts, items }) で、その区分のメモを保つ。
 */
export function categoryItemGroups(
  categories: readonly { value: string; summary?: string }[],
): CategoryItemGroup[] {
  return categories.map((c, i) => ({
    catIndex: i,
    category: c.value,
    parts: splitSummary(c.summary ?? ""),
  }));
}
