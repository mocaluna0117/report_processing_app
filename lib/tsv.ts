// 転記先Excelの列構成そのまま (空白列を含む24列)
export const COLUMNS = [
  "物件数", // 空白
  "PJ", // 契約番号
  "受付種別", // 点検時期
  "受付日", // 写真報告書の点検日 (yyyy/m/d)
  "受付者", // 固定「木村」
  "担当", // 空白
  "事業者", // 業務ルールで判定
  "物件名称", // 現場名の【】以降
  "お客様氏名", // 施主名
  "住所",
  "引渡日", // YYYY/MM/DD
  "監督", // 空白
  "営業", // 空白
  "初回訪問日", // 空白
  "前回対応日", // 空白
  "対応予定日", // 空白
  "完了日", // 空白
  "完了報告書取得日", // 空白
  "工事区分", // 点検報告書で「有」に丸が付いた項目 (1件=1行に展開)
  "アフター受付内容", // 不具合項目の状況からの要約
  "手配業者", // 空白
  "処置", // 空白
  "最終更新日", // 処理実行日「8月26日」
  "備考欄", // 「8/26　点検報告書作成」
] as const;

/** アフター受付内容の列番号 (UIで複数行セルにする) */
export const SUMMARY_COL = COLUMNS.indexOf("アフター受付内容");

/** 工事区分の列番号 (工事区分の数だけ行を展開する) */
export const WORK_COL = COLUMNS.indexOf("工事区分");

/** メール文の組み立てに使う列番号 (テーブルで編集した値をそのまま使うため) */
export const PROPERTY_COL = COLUMNS.indexOf("物件名称");
export const OWNER_COL = COLUMNS.indexOf("お客様氏名");
export const ADDRESS_COL = COLUMNS.indexOf("住所");
export const HANDOVER_COL = COLUMNS.indexOf("引渡日");

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
