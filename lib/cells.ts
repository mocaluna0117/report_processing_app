// 転記先Excelの1行 (24列) を列名で組み立てる。
// 位置合わせの配列だと COLUMNS を増減したときに黙ってずれるので、必ずこれを通す。
import { COLUMNS } from "@/lib/tsv";
import type { Confidence } from "@/lib/types";

export interface CellEntry {
  value: string;
  confidence: Confidence;
}

export type ColumnName = (typeof COLUMNS)[number];
/** 列名 → 値。指定しなかった列は空欄 (confidence: ok) になる */
export type CellInput = Partial<Record<ColumnName, CellEntry>>;

const BLANK: CellEntry = { value: "", confidence: "ok" };

/** 値と確度をそのまま入れる (抽出結果など) */
export function entry(value: string, confidence: Confidence = "ok"): CellEntry {
  return { value, confidence };
}

export function buildCells(input: CellInput): {
  cells: string[];
  confidences: Confidence[];
} {
  const entries = COLUMNS.map((name) => input[name] ?? BLANK);
  return {
    cells: entries.map((e) => e.value),
    confidences: entries.map((e) => e.confidence),
  };
}

/** 抽出に失敗した行 (全列空欄・全列 fail) */
export function blankCells(confidence: Confidence = "fail"): {
  cells: string[];
  confidences: Confidence[];
} {
  return {
    cells: COLUMNS.map(() => ""),
    confidences: COLUMNS.map(() => confidence),
  };
}
