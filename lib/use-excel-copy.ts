"use client";

// Excelへの貼り付け用コピー (コピー済み表示とフォールバック)。
import { useState } from "react";
import { copyRowsForExcel, toTsv } from "@/lib/tsv";

export interface ExcelCopy {
  includeHeader: boolean;
  setIncludeHeader: (value: boolean) => void;
  copied: boolean;
  copiedRowId: string | null;
  /** クリップボードが使えない環境向けのフォールバック本文 */
  fallbackTsv: string | null;
  closeFallback: () => void;
  copyAll: (rows: string[][]) => Promise<void>;
  copyRow: (rowId: string, rows: string[][]) => Promise<void>;
}

/** コピー済み表示を戻すまでの時間 */
const COPIED_MS = 2500;

export function useExcelCopy(): ExcelCopy {
  const [includeHeader, setIncludeHeader] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [fallbackTsv, setFallbackTsv] = useState<string | null>(null);

  const copyAll = async (rows: string[][]) => {
    try {
      await copyRowsForExcel(rows);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setFallbackTsv(toTsv(rows));
    }
  };

  const copyRow = async (rowId: string, rows: string[][]) => {
    try {
      await copyRowsForExcel(rows);
      setCopiedRowId(rowId);
      setTimeout(() => setCopiedRowId((prev) => (prev === rowId ? null : prev)), COPIED_MS);
    } catch {
      setFallbackTsv(toTsv(rows));
    }
  };

  return {
    includeHeader,
    setIncludeHeader,
    copied,
    copiedRowId,
    fallbackTsv,
    closeFallback: () => setFallbackTsv(null),
    copyAll,
    copyRow,
  };
}
