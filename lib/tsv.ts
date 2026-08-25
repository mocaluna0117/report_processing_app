export const COLUMNS = [
  "PJ",
  "受付種別",
  "事業者",
  "物件名称",
  "お客様氏名",
  "住所",
  "引渡日",
  "アフター受付内容",
  "最終更新日",
  "備考欄",
] as const;

function escapeTsvCell(v: string): string {
  let s = v.replace(/\t/g, " ");
  // 改行・引用符を含むセルはCSV流のクオートで包む (Excelの貼り付けで解釈される)
  if (/[\n\r"]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeTsvCell).join("\t")).join("\r\n");
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Excelはtext/htmlを優先して読む。<td>内の<br>はセル内改行として貼り付く */
export function toHtmlTable(rows: string[][]): string {
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((c) => `<td>${escapeHtml(c).replace(/\r?\n/g, "<br>")}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table>${body}</table>`;
}

/**
 * text/html (主) + text/plain (従) の二重書き込みでクリップボードへコピー。
 * 必ずクリックイベントハンドラ内から呼ぶこと (Safari対策)。
 * 失敗時は例外を投げるので、呼び出し側でtextareaフォールバックを出す。
 */
export async function copyRowsForExcel(rows: string[][]): Promise<void> {
  const tsv = toTsv(rows);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([toHtmlTable(rows)], { type: "text/html" }),
        "text/plain": new Blob([tsv], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(tsv);
}
