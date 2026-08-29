import { describe, expect, it } from "vitest";
import { decodeCsvBytes, detectDelimiter, parseCsv } from "@/lib/after/csv-read";

describe("parseCsv", () => {
  it("通常のカンマ区切り", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("引用符内の区切り・改行・二重引用符", () => {
    expect(parseCsv('a,"b,c","d\ne","f""g"')).toEqual([["a", "b,c", "d\ne", 'f"g']]);
  });

  it("CRLF と 末尾改行", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("空セルは空文字のまま保つ", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  it("タブ区切りも読める", () => {
    expect(parseCsv("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("detectDelimiter", () => {
  it("1行目のタブとカンマの数で決める", () => {
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
    expect(detectDelimiter("a,b,c\n")).toBe(",");
  });
});

describe("decodeCsvBytes", () => {
  it("UTF-8 (BOM付き) を読み、BOMを落とす", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("物件番号,居住者名")]);
    const { text, encoding } = decodeCsvBytes(bytes);
    expect(encoding).toBe("utf-8");
    expect(text).toBe("物件番号,居住者名");
  });

  it("Shift_JIS を自動判定して読む", () => {
    // 「山田」= 0x8E 0x52 0x93 0x63 (CP932)
    const bytes = new Uint8Array([0x8e, 0x52, 0x93, 0x63, 0x2c, 0x41]);
    const { text, encoding } = decodeCsvBytes(bytes);
    expect(encoding).toBe("shift_jis");
    expect(text).toBe("山田,A");
  });

  it("ASCIIのみならUTF-8として読む", () => {
    const { text, encoding } = decodeCsvBytes(new TextEncoder().encode("a,b"));
    expect(encoding).toBe("utf-8");
    expect(text).toBe("a,b");
  });
});
