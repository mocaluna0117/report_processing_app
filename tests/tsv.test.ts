import { describe, expect, it } from "vitest";
import {
  ADDRESS_COL,
  COLUMNS,
  HANDOVER_COL,
  INSPECTION_COLUMN_LABELS,
  OWNER_COL,
  PROPERTY_COL,
  SUMMARY_COL,
  columnHeaders,
  toHtmlTable,
  toTsv,
} from "@/lib/tsv";

describe("COLUMNS", () => {
  it("転記先Excelの24列構成と一致する", () => {
    expect(COLUMNS).toEqual([
      "物件数",
      "PJ",
      "受付種別",
      "受付日",
      "受付者",
      "担当",
      "事業者",
      "物件名称",
      "お客様氏名",
      "住所",
      "引渡日",
      "監督",
      "営業",
      "初回訪問日",
      "前回対応日",
      "対応予定日",
      "完了日",
      "完了報告書取得日",
      "工事区分",
      "アフター受付内容",
      "手配業者",
      "処置",
      "最終更新日",
      "備考欄",
    ]);
    expect(SUMMARY_COL).toBe(19);
    // メール文の組み立てに使う列
    expect(PROPERTY_COL).toBe(7);
    expect(OWNER_COL).toBe(8);
    expect(ADDRESS_COL).toBe(9);
    expect(HANDOVER_COL).toBe(10);
  });
});

describe("columnHeaders", () => {
  it("読み替えなしなら COLUMNS のまま (アフターメンテナンス)", () => {
    expect(columnHeaders()).toEqual([...COLUMNS]);
  });

  it("定期点検はアフター受付内容を「点検内容」として貼り付ける", () => {
    const headers = columnHeaders(INSPECTION_COLUMN_LABELS);
    expect(headers[SUMMARY_COL]).toBe("点検内容");
    expect(headers).toHaveLength(COLUMNS.length);
    // 読み替えるのは要約の列だけ (他の列名は変えない)
    expect(headers.filter((h, i) => h !== COLUMNS[i])).toEqual(["点検内容"]);
  });

  it("cells の位置を決める COLUMNS 自体は変えない", () => {
    expect(COLUMNS[SUMMARY_COL]).toBe("アフター受付内容");
  });
});

describe("toTsv", () => {
  it("通常セルはそのままタブ区切り", () => {
    expect(toTsv([["A", "B"], ["C", "D"]])).toBe("A\tB\r\nC\tD");
  });

  it("改行を含むセルはクオートで包む", () => {
    expect(toTsv([["a\nb", "c"]])).toBe('"a\nb"\tc');
  });

  it("引用符は二重化する", () => {
    expect(toTsv([['幅"1m"程度']])).toBe('"幅""1m""程度"');
  });

  it("セル内タブはスペースに置換 (列崩れ防止)", () => {
    expect(toTsv([["a\tb"]])).toBe("a b");
  });
});

describe("toHtmlTable", () => {
  it("セル内改行は<br>になり、HTML特殊文字はエスケープされる", () => {
    const html = toHtmlTable([["a\nb", "<x> & y"]]);
    expect(html).toBe(
      "<table><tr><td>a<br>b</td><td>&lt;x&gt; &amp; y</td></tr></table>",
    );
  });
});
