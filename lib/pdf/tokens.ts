import { toHalfWidthAlnum } from "@/lib/text";
import type { TextToken } from "@/lib/types";

interface TextItemLike {
  str: string;
  transform: number[];
}

function isTextItem(it: unknown): it is TextItemLike {
  return (
    typeof it === "object" &&
    it !== null &&
    typeof (it as TextItemLike).str === "string" &&
    Array.isArray((it as TextItemLike).transform)
  );
}

/**
 * pdfjs getTextContent() の items を上端原点のトークンに変換する。
 * ブラウザ (extract.ts) と Node (テスト/ダンプ) で共有する純関数。
 */
export function mapTextItems(
  items: readonly unknown[],
  pageHeight: number,
  page: number,
): TextToken[] {
  const out: TextToken[] = [];
  for (const it of items) {
    if (!isTextItem(it)) continue; // TextMarkedContent 等は無視
    // 英数字は全出力で半角に揃える (ここがPDF由来テキストの単一の入口)
    const str = toHalfWidthAlnum(it.str.normalize("NFC"))
      .replace(/�/g, "")
      .trim();
    if (!str) continue;
    out.push({
      str,
      x: it.transform[4],
      y: pageHeight - it.transform[5],
      page,
    });
  }
  return out;
}
