import { describe, expect, it } from "vitest";
import { toHtmlTable, toTsv } from "@/lib/tsv";

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
