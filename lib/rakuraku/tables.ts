import "server-only";
import type { Frame, Page } from "playwright-core";
import { type TableData, tableContentKey } from "./parse/tables";

/**
 * 画面の表を読む。値の選び方（純粋な規則）は `parse/tables.ts`。
 *
 * 移植元: tenmatsu.py 4228-4282（`_TABLES_JS` / read_frame_tables / scan_tables_everywhere / scan_text_everywhere）
 */

/**
 * フレーム内の表を読む。読めなければ空の配列（落とさない）。
 *
 * 伝票画面の「ラベル→値」の表と、承認履歴の表の両方に使う。
 * 承認履歴の構造が未確認なので、決まったセレクタに頼らず「見えている表」を全部拾う。
 * ★見えているかは checkVisibility() で見る。モーダルは position:fixed のことがあり、
 *   offsetParent では判定できない。
 * ★`&nbsp;`（U+00A0）はスペースに直してから前後を落とす。空きの枠が空文字になるように。
 */
export async function readFrameTables(frame: Frame, selector = "table", visibleOnly = true): Promise<TableData[]> {
  const tables = await frame
    .evaluate((sel: string): (TableData & { visible: boolean })[] => {
      const txt = (el: Element) =>
        ((el as HTMLElement).innerText || el.textContent || "").replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ");
      // 表示が省略されている列は title 属性に全文が入っていることがあるので、長い方を採る
      const cellText = (el: Element) => {
        const shown = txt(el);
        const title = (el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
        return title.length > shown.length ? title : shown;
      };
      const visible = (el: Element) =>
        typeof (el as HTMLElement).checkVisibility === "function"
          ? (el as HTMLElement).checkVisibility()
          : el.getClientRects().length > 0;
      // 指定が <table> でない要素にも耐えるようにする
      const rowsOf = (t: Element) => {
        const rows = (t as HTMLTableElement).rows ?? t.querySelectorAll("tr");
        return Array.from(rows).map((r) =>
          Array.from((r as HTMLTableRowElement).cells ?? r.children).map(cellText),
        );
      };
      return Array.from(document.querySelectorAll(sel || "table"))
        .map((t) => ({
          id: t.id || null,
          cls: typeof t.className === "string" && t.className ? t.className : null,
          visible: visible(t),
          rows: rowsOf(t),
        }))
        .filter((t) => t.rows.length > 0);
    }, selector || "table")
    .catch(() => [] as (TableData & { visible: boolean })[]);
  return visibleOnly ? tables.filter((t) => t.visible) : tables;
}

/**
 * 開いている全ページ・全フレームの「見えている表」を集める。
 *
 * 承認履歴が (a) 同じ画面の <div> ダイアログ (b) 別フレーム/iframe (c) 別ウィンドウ の
 * どれで開くのか分かっていないため、3通りすべてを拾えるよう全部を見る。
 * before を渡すと、そこに無い表に isNew=true を付ける（クリック後に現れた表だけを見たい場面のため）。
 * ★中身まで見て比べる（tableContentKey）。元からある表に履歴が流し込まれる作りでも
 *   「クリックで現れた」と分かるようにするため。
 */
export async function scanTablesEverywhere(
  page: Page,
  before?: ReadonlySet<string>,
  selector = "table",
): Promise<TableData[]> {
  const out: TableData[] = [];
  for (const target of page.context().pages()) {
    for (const frame of target.frames()) {
      for (const table of await readFrameTables(frame, selector)) {
        out.push({ ...table, isNew: before === undefined || !before.has(tableContentKey(table)) });
      }
    }
  }
  return out;
}

/** 開いている全ページ・全フレームの表示テキストをつなげて返す（承認履歴が表で書かれていなかったときの最後の手段） */
export async function scanTextEverywhere(page: Page): Promise<string> {
  const out: string[] = [];
  for (const target of page.context().pages()) {
    for (const frame of target.frames()) {
      const text = await frame.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => null);
      if (text) out.push(text);
    }
  }
  return out.join("\n");
}
