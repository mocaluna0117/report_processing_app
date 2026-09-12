import { describe, expect, it } from "vitest";
import { composeNatsuinParts, firstParen, last4, natsuinFinalName } from "@/lib/rakuraku/parse/natsuin";

// 期待値は移植元の検証 (tenmatsu-dl/smoke_test.py「捺印決裁書」) から写した。すべて架空の値
describe("専決決裁書の添付を選んで並べる", () => {
  const names = [
    "見積総覧（架空邸）.pdf",
    "見積：架空商店　20260916.pdf",
    "写真1.jpg",
    "無関係.xlsx",
    "【決定通知書】保険金支払額の計算（架空県_架空邸_123）.pdf",
  ];

  it("★決定通知書があればパターン2（決定通知書だけ）", () => {
    const p2 = composeNatsuinParts(names);
    expect(p2.pattern).toBe(2);
    expect(p2.picked.map((x) => x.name)).toEqual([names[4]]);
    expect(p2.paren).toBe("架空県_架空邸_123");
  });

  it("★決定通知書が無ければ 見積総覧→見積→写真 の順", () => {
    const p1 = composeNatsuinParts(names.slice(0, 4));
    expect(p1.pattern).toBe(1);
    expect(p1.picked.map((x) => x.name)).toEqual(names.slice(0, 3));
  });

  it("★要件に合わない添付は無視する（無関係.xlsx）", () => {
    expect(composeNatsuinParts(names.slice(0, 4)).picked.some((x) => x.name.includes("無関係"))).toBe(false);
  });

  it("★名前は見積総覧の（）から", () => {
    expect(composeNatsuinParts(names.slice(0, 4)).paren).toBe("架空邸");
  });

  it("★見積総覧が無ければ「見積：」の後ろを使う（間の全角空白は残す）", () => {
    expect(composeNatsuinParts(names.slice(1, 4)).paren).toBe("架空商店　20260916");
  });

  it("半角の括弧も読む", () => {
    expect(composeNatsuinParts(["見積総覧(架空邸).pdf"]).paren).toBe("架空邸");
  });

  it("括弧が無ければ名前を決めない", () => {
    expect(composeNatsuinParts(["見積総覧.pdf"]).paren).toBeNull();
  });

  it("添付が無くても止まらない", () => {
    expect(composeNatsuinParts([])).toEqual({ pattern: 1, picked: [], paren: null, parenFrom: null });
  });

  it("★御見積書は名前の元にするだけで、結合はしない", () => {
    expect(composeNatsuinParts(["御見積書（架空邸）.pdf", "写真1.jpg"]).picked.map((x) => x.name)).toEqual([
      "写真1.jpg",
    ]);
  });
});

describe("確定するときの名前", () => {
  const fname = (names: string[]) =>
    natsuinFinalName(composeNatsuinParts(names), {}, "NK00001489", "捺印決裁書No.");
  const fallback = "捺印決裁書No.1489.pdf";

  const cannot: [string, string[]][] = [
    ["添付が無い", []],
    ["要件に合う添付が無い", ["請求書控え.xlsx", "メモ.txt"]],
    ["写真だけ（名前の元にならない）", ["写真1.jpg"]],
    ["見積総覧に括弧が無い（御見積書も無い）", ["見積総覧.pdf"]],
    ["括弧の中が空", ["見積総覧（）.pdf"]],
    ["決定通知書に括弧が無い", ["【決定通知書】保険金支払額の計算.pdf"]],
    // ★拡張子の切り落としを誤ると「.pdf」を名前にしてしまう
    ["見積：の後ろが空", ["見積：.pdf"]],
  ];
  for (const [label, names] of cannot) {
    it(`★名前を決められないとき（${label}）は接頭辞＋下4桁`, () => {
      expect(fname(names)).toBe(fallback);
    });
  }

  it("★見積総覧に括弧が無くても「見積：」があれば使う", () => {
    expect(fname(["見積総覧.pdf", "見積：架空商店.pdf"])).toBe("御見積書（架空商店）.pdf");
  });

  it("★決定通知書からなら保険金請求書、それ以外は御見積書", () => {
    expect(fname(["【決定通知書】保険金支払額の計算（架空県_架空邸）.pdf"])).toBe("保険金請求書（架空県_架空邸）.pdf");
    expect(fname(["見積総覧（架空邸）.pdf"])).toBe("御見積書（架空邸）.pdf");
  });

  it("★ほかで決められないときは「御見積書（〇〇）」から決める", () => {
    expect(fname(["御見積書（基礎巾木補修工事）.pdf"])).toBe("御見積書（基礎巾木補修工事）.pdf");
    expect(fname(["写真1.jpg", "御見積書（基礎巾木補修工事）.pdf"])).toBe("御見積書（基礎巾木補修工事）.pdf");
  });

  it("★決定通知書に括弧が無くても、御見積書があれば「御見積書」にする", () => {
    expect(fname(["【決定通知書】保険金支払額の計算.pdf", "御見積書（架空邸）.pdf"])).toBe("御見積書（架空邸）.pdf");
  });

  it("★見積総覧があれば御見積書より優先する", () => {
    expect(fname(["見積総覧（架空邸）.pdf", "御見積書（別）.pdf"])).toBe("御見積書（架空邸）.pdf");
  });

  it("★括弧の中身に置換の特殊記号があっても名前が化けない", () => {
    expect(fname(["見積総覧（A$&B$1）.pdf"])).toBe("御見積書（A$&B$1）.pdf");
  });
});

describe("下4桁", () => {
  it("数字の末尾4桁", () => {
    expect(last4("TE00009002")).toBe("9002");
    expect(last4("TE00001476")).toBe("1476");
  });
  it("数字が4桁未満なら文字列の末尾4文字", () => {
    expect(last4("AB12")).toBe("AB12");
  });
});

describe("括弧の中身", () => {
  it("最初に出てくるものを採る", () => {
    expect(firstParen("A（一）B（二）")).toBe("一");
  });
  it("空なら null", () => {
    expect(firstParen("A（ ）")).toBeNull();
    expect(firstParen(null)).toBeNull();
  });
});
