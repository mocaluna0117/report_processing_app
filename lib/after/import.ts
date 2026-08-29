// 顧客データファイル (xlsx / csv) を読んで Customer の配列にする。
// 純関数 (IndexedDB には触らない) なのでテストしやすく、取り込み結果を画面で確認してから保存できる。
import { decodeCsvBytes, parseCsv } from "@/lib/after/csv-read";
import { dxRowToCustomer } from "@/lib/after/dx";
import { effectiveFields } from "@/lib/after/customer";
import { suketToCustomer } from "@/lib/after/suketto";
import { detectSource, isEmptyRow, rowToRecord } from "@/lib/after/table";
import type { Customer, CustomerSource } from "@/lib/after/types";
import { isZip, readXlsxSheets } from "@/lib/after/xlsx-read";

export class CustomerImportError extends Error {}

/** 取り込まなかった行のまとめ (顧客名は載せず、行番号だけにする) */
export interface SkippedGroup {
  reason: string;
  count: number;
  /** 元ファイルの行番号 (1始まり)。多い場合は先頭のみ */
  rows: number[];
}

export interface ParsedImport {
  source: CustomerSource;
  fileName: string;
  /** xlsx のときのシート名 */
  sheetName: string | null;
  customers: Customer[];
  skipped: SkippedGroup[];
  /** ヘッダー行を除いたデータ行数 */
  totalRows: number;
}

/** 1つの理由につき記録する行番号の上限 (レポートが長くなりすぎないように) */
const MAX_REPORTED_ROWS = 20;

class SkipLog {
  private readonly groups = new Map<string, SkippedGroup>();

  add(reason: string, row: number): void {
    const group = this.groups.get(reason) ?? { reason, count: 0, rows: [] };
    group.count += 1;
    if (group.rows.length < MAX_REPORTED_ROWS) group.rows.push(row);
    this.groups.set(reason, group);
  }

  list(): SkippedGroup[] {
    return [...this.groups.values()].sort((a, b) => b.count - a.count);
  }
}

/** ファイルの中身を「行の配列」にする (xlsx は取り込める形式のシートを探す) */
function readTable(
  bytes: Uint8Array,
  fileName: string,
): { rows: string[][]; sheetName: string | null } {
  if (isZip(bytes) || /\.xlsx$/i.test(fileName)) {
    const sheets = readXlsxSheets(bytes);
    // 顧客情報のヘッダーを持つ最初のシートを使う (説明用シートが先頭にあることがある)
    const target = sheets.find((s) => detectSource(s.rows) !== null) ?? sheets[0];
    if (!target) throw new CustomerImportError("シートが見つかりません");
    return { rows: target.rows, sheetName: target.name };
  }
  const { text } = decodeCsvBytes(bytes);
  return { rows: parseCsv(text), sheetName: null };
}

/**
 * 顧客データファイルを解析する。
 * 形式 (助っ人クラウド / 点検保守台帳) はヘッダーの並びから自動判定する。
 */
export function parseCustomerFile(
  bytes: Uint8Array,
  fileName: string,
  now: number = Date.now(),
): ParsedImport {
  const { rows, sheetName } = readTable(bytes, fileName);
  const detected = detectSource(rows);
  if (!detected) {
    throw new CustomerImportError(
      "顧客データの形式を判定できません (助っ人クラウド または 点検保守台帳 の列が必要です)",
    );
  }
  const { source, header } = detected;
  const skipped = new SkipLog();
  const byId = new Map<string, Customer>();
  let totalRows = 0;

  for (let r = header.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const lineNo = r + 1;
    if (isEmptyRow(row)) {
      skipped.add("空行", lineNo);
      continue;
    }
    totalRows += 1;
    const record = rowToRecord(row, header);
    const result =
      source === "dx" ? dxRowToCustomer(record, lineNo, now) : suketToCustomer(record, lineNo, now);
    if (!result.ok) {
      skipped.add(result.skipReason, lineNo);
      continue;
    }
    if (byId.has(result.customer.id)) {
      // 同じ内容の行 (助っ人クラウドの重複行) は1件にまとめる
      skipped.add("内容が同じ行", lineNo);
      continue;
    }
    byId.set(result.customer.id, result.customer);
  }

  return {
    source,
    fileName,
    sheetName,
    customers: [...byId.values()],
    skipped: skipped.list(),
    totalRows,
  };
}

/** 取り込み結果のうち、確認が必要な件数 */
export function countNeedsReview(customers: Customer[]): number {
  return customers.filter((c) => c.issues.length > 0).length;
}

/** 助っ人クラウドと点検保守台帳で同じPJを持つ顧客 (画面で注意を出す) */
export function findPjCollisions(customers: Customer[]): Map<string, Customer[]> {
  const byPj = new Map<string, Customer[]>();
  for (const c of customers) {
    const pj = effectiveFields(c).pj;
    if (!pj) continue;
    byPj.set(pj, [...(byPj.get(pj) ?? []), c]);
  }
  return new Map([...byPj].filter(([, list]) => new Set(list.map((c) => c.source)).size > 1));
}
