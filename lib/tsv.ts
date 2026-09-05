// 転記先Excelの列構成そのまま (空白列を含む24列)
export const COLUMNS = [
  "物件数", // ★ (記録1件につき先頭の行だけ)
  "PJ", // 契約番号
  "受付種別", // 点検時期
  "受付日", // 写真報告書の点検日 (yyyy/m/d)
  "受付者", // 固定「木村」
  "担当", // 空白
  "事業者", // 業務ルールで判定
  "物件名称", // 現場名の【】以降
  "お客様氏名", // 施主名
  "住所",
  "引渡日", // yyyy/mm/dd (ゼロ埋め)
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

/** 処置の列番号 (アフター受付内容と同じ大きさの入力欄にする) */
export const TREATMENT_COL = COLUMNS.indexOf("処置");

/**
 * 定期点検で使う列名の読み替え (転記先シートの見出しに合わせる)。
 * COLUMNS 自体は cells の位置を決める内部の名前なので変えず、表示と貼り付けのヘッダーだけ差し替える。
 */
export const INSPECTION_COLUMN_LABELS: Readonly<Record<number, string>> = {
  [SUMMARY_COL]: "点検内容",
};

/** 貼り付け用のヘッダー行 (読み替えを当てた列名) */
export function columnHeaders(labels?: Readonly<Record<number, string>>): string[] {
  return COLUMNS.map((c, i) => labels?.[i] ?? c);
}

/**
 * 物件数の列と、そこに入れる印。
 * 転記先シートでは記録1件につき★を1つ置き、その数で物件数を数える。
 * 工事区分の数だけ行に展開しても件数が増えないよう、★は先頭の行にだけ残す (lib/rows.ts の expandRow)。
 */
export const PROPERTY_COUNT_COL = COLUMNS.indexOf("物件数");
export const PROPERTY_COUNT_MARK = "★";

/** メール文・完了報告書の組み立てに使う列番号 (テーブルで編集した値をそのまま使うため) */
export const PJ_COL = COLUMNS.indexOf("PJ");
export const RECEPTION_TYPE_COL = COLUMNS.indexOf("受付種別");
export const RECEPTION_DATE_COL = COLUMNS.indexOf("受付日");
export const PROPERTY_COL = COLUMNS.indexOf("物件名称");
export const OWNER_COL = COLUMNS.indexOf("お客様氏名");
export const ADDRESS_COL = COLUMNS.indexOf("住所");
export const HANDOVER_COL = COLUMNS.indexOf("引渡日");
/** 監督・営業。アフターメンテナンスのお客様の情報から反映する (24列の構成は変えない) */
export const SUPERVISOR_COL = COLUMNS.indexOf("監督");
export const SALES_COL = COLUMNS.indexOf("営業");
export const RECEPTIONIST_COL = COLUMNS.indexOf("受付者");
export const DEVELOPER_COL = COLUMNS.indexOf("事業者");
export const LAST_UPDATED_COL = COLUMNS.indexOf("最終更新日");
/** 備考欄。アフターメンテナンスではこの列を貼り付けない */
export const REMARKS_COL = COLUMNS.indexOf("備考欄");

/**
 * 1セル分のテキストを、貼り付けても行がずれない形にする。
 * Excel の「貼り付け」はクリップボードのプレーンテキストを単純に改行で行・タブで列に切るだけで、
 * CSV のようなクオート ("...") は解釈しない。改行を残すとその分だけ行が増えてしまうので、
 * タブ・改行は半角スペースに畳んで1行にする (改行を保ったまま1セルに収めるのは text/html 側の役割)。
 */
function escapeTsvCell(v: string): string {
  return v
    .replace(/[ \t]*(?:\r\n|\r|\n)+[ \t]*/g, " ")
    .replace(/\t/g, " ")
    .replace(/^ +| +$/g, "");
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeTsvCell).join("\t")).join("\r\n");
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Excel・Googleスプレッドシートは text/html を優先して読む。こちらは改行を保てる。
 * ただし素の <br> だと Excel は改行ごとにセルを分けてしまう。
 * これを防ぐ指定は <td> ではなく <br> 自身に付ける必要がある (Microsoft のフォーラムの回答)。
 * https://learn.microsoft.com/en-us/archive/msdn-technet-forums/d80a2ce8-997a-4507-b80e-4f6b9a17bcaa
 */
const SAME_CELL_BR = '<br style="mso-data-placement:same-cell">';

export function toHtmlTable(rows: string[][]): string {
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map(
            (c) =>
              `<td style="white-space:pre-wrap">${escapeHtml(c).replace(/\r?\n/g, SAME_CELL_BR)}</td>`,
          )
          .join("")}</tr>`,
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
