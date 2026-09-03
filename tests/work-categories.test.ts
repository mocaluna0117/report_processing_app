import { describe, expect, it } from "vitest";
import {
  WORK_CATEGORIES,
  isWorkCategory,
  normalizeWorkCategory,
  workCategoryOrder,
} from "@/lib/work-categories";

describe("WORK_CATEGORIES", () => {
  it("指定された30区分を定義順に持つ", () => {
    expect(WORK_CATEGORIES).toHaveLength(30);
    expect(WORK_CATEGORIES[0]).toBe("基礎");
    expect(WORK_CATEGORIES[29]).toBe("その他");
    expect(isWorkCategory("クロス")).toBe(true);
    expect(isWorkCategory("外部塗装")).toBe(false);
  });
});

describe("normalizeWorkCategory", () => {
  it("一覧にある名称はそのまま", () => {
    expect(normalizeWorkCategory("クロス")).toBe("クロス");
    expect(normalizeWorkCategory(" 内部建材 ")).toBe("内部建材");
  });

  it("チェックシート上の括弧付き表記を対応付ける", () => {
    expect(normalizeWorkCategory("外部建具(サッシ)")).toBe("サッシ");
    expect(normalizeWorkCategory("外部天井（軒天）")).toBe("軒天");
    expect(normalizeWorkCategory("ユニットバス(浴室)")).toBe("ユニットバス");
  });

  it("別名を対応付ける", () => {
    expect(normalizeWorkCategory("ベランダ")).toBe("バルコニー");
    expect(normalizeWorkCategory("洗面台")).toBe("洗面化粧台");
    expect(normalizeWorkCategory("屋根裏")).toBe("小屋裏");
  });

  it("部分一致は最長一致を優先する", () => {
    expect(normalizeWorkCategory("玄関タイル欠け")).toBe("玄関タイル");
    expect(normalizeWorkCategory("換気システム不良")).toBe("換気システム");
  });

  it("対応付けできない名称は null", () => {
    expect(normalizeWorkCategory("外部塗装")).toBeNull();
    expect(normalizeWorkCategory("")).toBeNull();
  });
});

describe("workCategoryOrder", () => {
  it("一覧順のインデックスを返し、不明な値は末尾", () => {
    expect(workCategoryOrder("基礎")).toBe(0);
    expect(workCategoryOrder("その他")).toBe(29);
    expect(workCategoryOrder("不明")).toBe(30);
  });
});

describe("normalizeHits (画像認識出力の正規化)", () => {
  it("区分に正規化し、重複をまとめ、一覧順に並べる", async () => {
    const { normalizeHits } = await import("@/lib/work-categories");
    const hits = normalizeHits([
      { item: "内部建材", category: "内部建材", confidence: "high" },
      { item: "クロス", category: "クロス", confidence: "low" },
      { item: "クロス", category: "クロス", confidence: "high" }, // 重複 → high を採用
      { item: "外部建具(サッシ)", category: "不明な値", confidence: "high" }, // item から正規化
      { item: "外部塗装", category: "不明な値", confidence: "high" }, // 正規化不能 → その他/low
    ]);
    expect(hits.map((h) => h.category)).toEqual(["サッシ", "クロス", "内部建材", "その他"]);
    expect(hits.find((h) => h.category === "クロス")?.confidence).toBe("high");
    expect(hits.find((h) => h.category === "その他")?.confidence).toBe("low");
  });

  it("不正な形の要素は無視せず安全に扱う", async () => {
    const { normalizeHits } = await import("@/lib/work-categories");
    expect(normalizeHits([{}, { item: 123, category: null }])).toEqual([
      { category: "その他", item: "その他", confidence: "low" },
    ]);
  });
});

describe("categoryKeywords / findCategoryInText", () => {
  it("区分名と別名を手がかりとして返す", async () => {
    const { categoryKeywords } = await import("@/lib/work-categories");
    expect(categoryKeywords("ユニットバス")).toEqual(
      expect.arrayContaining(["ユニットバス", "浴室", "UB"]),
    );
    expect(categoryKeywords("クロス")).toEqual(expect.arrayContaining(["クロス", "壁紙"]));
    expect(categoryKeywords("")).toEqual([]);
  });

  it("本文中で後に現れた語の区分を採る (場所より部位を優先)", async () => {
    const { findCategoryInText } = await import("@/lib/work-categories");
    expect(findCategoryInText("浴室の換気扇から異音", ["ユニットバス", "換気システム"])).toBe(
      "換気システム",
    );
    expect(findCategoryInText("浴室の床がぶかぶかする", ["ユニットバス", "クロス"])).toBe(
      "ユニットバス",
    );
  });

  it("空欄と「その他」は当てない", async () => {
    const { findCategoryInText } = await import("@/lib/work-categories");
    expect(findCategoryInText("その他の不具合", ["", "その他"])).toBeNull();
    expect(findCategoryInText("1階洋室のクロスに凹凸", ["", "その他", "クロス"])).toBe("クロス");
  });

  it("全角・空白は無視して一致させる", async () => {
    const { findCategoryInText } = await import("@/lib/work-categories");
    expect(findCategoryInText("２階 ＵＢ の扉が閉まらない", ["ユニットバス"])).toBe("ユニットバス");
  });

  it("手がかりが無ければ null", async () => {
    const { findCategoryInText } = await import("@/lib/work-categories");
    expect(findCategoryInText("2階階段ササラ仕上げの剥がれ", ["クロス", "サッシ"])).toBeNull();
    expect(findCategoryInText("", ["クロス"])).toBeNull();
  });
});
