// 取り込んだ表 (xlsx/csv) のヘッダー行を見つけ、列名でセルを引けるようにする。
// ヘッダーには改行や「※必須」が入るので、比較用に正規化してから突き合わせる。
import type { CustomerSource } from "@/lib/after/types";

/** 「※必須\n施主名（姓）」→「施主名(姓)」 */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/※\s*必須/g, "")
    .replace(/[\s　]/g, "");
}

export interface HeaderMap {
  /** 0始まりの行番号 */
  headerRow: number;
  /** 正規化した列名 → 列番号 */
  columns: Map<string, number>;
}

/** 助っ人クラウド (旧システム) と判定するのに必要な列 */
export const SUKETTO_REQUIRED = ["管理ID", "施主名(姓)", "建築地都道府県"] as const;
/** 点検保守台帳 (DX) と判定するのに必要な列 */
export const DX_REQUIRED = ["物件番号", "居住者名", "所在地住居表示"] as const;

/** 先頭の数行からヘッダー行を探す (説明行が上に付いていることがある) */
export function findHeaderRow(
  rows: string[][],
  required: readonly string[],
  scanRows = 20,
): HeaderMap | null {
  for (let r = 0; r < Math.min(rows.length, scanRows); r++) {
    const columns = new Map<string, number>();
    rows[r].forEach((cell, c) => {
      const name = normalizeHeader(cell);
      // 同名の列があれば左側を優先する
      if (name && !columns.has(name)) columns.set(name, c);
    });
    if (required.every((name) => columns.has(name))) return { headerRow: r, columns };
  }
  return null;
}

/** ヘッダーの並びから取り込み元の形式を判定する */
export function detectSource(rows: string[][]): {
  source: CustomerSource;
  header: HeaderMap;
} | null {
  const dx = findHeaderRow(rows, DX_REQUIRED);
  if (dx) return { source: "dx", header: dx };
  const suketto = findHeaderRow(rows, SUKETTO_REQUIRED);
  if (suketto) return { source: "suketto", header: suketto };
  return null;
}

/** 正規化した列名で値を引く (無い列は空文字) */
export function rowToRecord(row: string[], header: HeaderMap): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, index] of header.columns) record[name] = row[index] ?? "";
  return record;
}

/** すべてのセルが空か (取り込み対象から外す) */
export function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}
