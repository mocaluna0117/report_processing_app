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

  it("セル内の改行は半角スペースに畳む (貼り付け先で行が増えないように)", () => {
    expect(toTsv([["①玄関ドアのこすれ\n②外壁のひび", "c"]])).toBe(
      "①玄関ドアのこすれ ②外壁のひび\tc",
    );
    // CRLF・連続改行・行頭行末の空白もまとめて1つのスペースにする
    expect(toTsv([["a\r\n\r\nb"]])).toBe("a b");
    expect(toTsv([["a \n  b"]])).toBe("a b");
    expect(toTsv([["a\n"]])).toBe("a");
  });

  it("引用符はそのまま残す (Excelの貼り付けはクオートを解釈しないため)", () => {
    expect(toTsv([['幅"1m"程度']])).toBe('幅"1m"程度');
  });

  it("セル内タブはスペースに置換 (列崩れ防止)", () => {
    expect(toTsv([["a\tb"]])).toBe("a b");
  });

  it("全角スペースは壊さない (氏名の姓名区切り)", () => {
    expect(toTsv([["山田　太郎", "点検\n内容"]])).toBe("山田　太郎\t点検 内容");
  });

  it("どのセルに改行があっても行数と列数は元のまま", () => {
    const rows = [
      ["a\nb", "c", "d\r\ne"],
      ["f", "g\n\nh", "i"],
    ];
    const lines = toTsv(rows).split("\r\n");
    expect(lines).toHaveLength(rows.length);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line.split("\t")).toHaveLength(3);
    }
  });
});

describe("toHtmlTable", () => {
  it("セル内改行は<br>になり、HTML特殊文字はエスケープされる", () => {
    const html = toHtmlTable([["a\nb", "<x> & y"]]);
    expect(html).toContain("<td style=\"mso-data-placement:same-cell;white-space:pre-wrap\">a<br>b</td>");
    expect(html).toContain("&lt;x&gt; &amp; y");
    expect(html.startsWith("<table><tr>")).toBe(true);
  });

  it("Excelがセル内改行として扱うための指定が全セルに付く", () => {
    const html = toHtmlTable([["a\nb", "c"], ["d", "e"]]);
    expect(html.match(/mso-data-placement:same-cell/g)).toHaveLength(4);
  });
});
