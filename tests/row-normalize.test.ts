import { describe, expect, it } from "vitest";
import { normalizeStoredRow } from "@/lib/row-normalize";
import { COLUMNS, PROPERTY_COUNT_COL, PROPERTY_COUNT_MARK, SUMMARY_COL } from "@/lib/tsv";
import type { WorkCategoryEntry } from "@/lib/types";

const cells = (summary: string, propertyCount = PROPERTY_COUNT_MARK) =>
  COLUMNS.map((c, i) =>
    i === SUMMARY_COL ? summary : i === PROPERTY_COUNT_COL ? propertyCount : `v:${c}`,
  );

const row = (over: {
  summary?: string;
  propertyCount?: string;
  categories?: WorkCategoryEntry[];
  /** ★を扱うようになったあとに保存された行か (省略時は古い保存データ) */
  propertyCountMarked?: boolean;
}) => ({
  pairId: "p-1",
  cells: cells(over.summary ?? "本文", over.propertyCount ?? PROPERTY_COUNT_MARK),
  categories: over.categories ?? [],
  propertyCountMarked: over.propertyCountMarked,
});

describe("normalizeStoredRow", () => {
  it("物件数が空欄なら★を入れ、他の列は触らない", () => {
    const before = row({ propertyCount: "" });
    const after = normalizeStoredRow(before);
    expect(after.cells[PROPERTY_COUNT_COL]).toBe(PROPERTY_COUNT_MARK);
    expect(after.cells.slice(1)).toEqual(before.cells.slice(1));
  });

  it("★を扱ったあとの行で空欄なら、消したとみなして戻さない", () => {
    const before = row({ propertyCount: "", propertyCountMarked: true });
    expect(normalizeStoredRow(before).cells[PROPERTY_COUNT_COL]).toBe("");
  });

  it("読み替えた行には印を残す (次の読み込みで★を戻さない)", () => {
    const once = normalizeStoredRow(row({ propertyCount: "" }));
    expect(once.propertyCountMarked).toBe(true);
    expect(once.cells[PROPERTY_COUNT_COL]).toBe(PROPERTY_COUNT_MARK);
    // その行の★を消して読み直しても戻らない
    const cleared = { ...once, cells: once.cells.map((v, i) => (i === PROPERTY_COUNT_COL ? "" : v)) };
    expect(normalizeStoredRow(cleared).cells[PROPERTY_COUNT_COL]).toBe("");
  });

  it("物件数に値が入っていれば変えない", () => {
    expect(normalizeStoredRow(row({ propertyCount: "2" })).cells[PROPERTY_COUNT_COL]).toBe("2");
  });

  it("分ける前の形式 (区分2件・本文なし) は振り分けてセルを鏡にする", () => {
    const after = normalizeStoredRow(
      row({
        summary: "①1階洋室のクロスに凹凸\n②玄関サッシの結露",
        categories: [
          { value: "クロス", confidence: "ok" },
          { value: "サッシ", confidence: "ok" },
        ],
      }),
    );
    expect(after.categories.map((c) => c.summary)).toEqual([
      "1階洋室のクロスに凹凸",
      "玄関サッシの結露",
    ]);
    expect(after.cells[SUMMARY_COL]).toBe("①1階洋室のクロスに凹凸\n②玄関サッシの結露");
  });

  it("分けていた行は共通のセルを鏡に揃える (隠れていた古い本文は捨てる)", () => {
    const after = normalizeStoredRow(
      row({
        summary: "分ける前の本文",
        categories: [
          { value: "クロス", confidence: "ok", summary: "クロスに凹凸" },
          { value: "サッシ", confidence: "ok", summary: "サッシの結露" },
        ],
      }),
    );
    expect(after.cells[SUMMARY_COL]).toBe("①クロスに凹凸\n②サッシの結露");
    expect(after.categories.map((c) => c.summary)).toEqual(["クロスに凹凸", "サッシの結露"]);
  });

  it("工事区分が1件以下なら区分に残った本文を外し、セルは触らない", () => {
    const after = normalizeStoredRow(
      row({
        summary: "共通の本文",
        categories: [{ value: "クロス", confidence: "ok", summary: "古い本文" }],
      }),
    );
    expect(after.categories[0].summary).toBeUndefined();
    expect(after.cells[SUMMARY_COL]).toBe("共通の本文");
  });

  it("使わなくなった splitSummary フラグは落とす", () => {
    const after = normalizeStoredRow({ ...row({}), splitSummary: true });
    expect("splitSummary" in after).toBe(false);
  });

  it("何度通しても同じ結果 (冪等)", () => {
    const once = normalizeStoredRow(
      row({
        propertyCount: "",
        summary: "①クロスに凹凸\n②サッシの結露",
        categories: [
          { value: "クロス", confidence: "ok" },
          { value: "サッシ", confidence: "ok" },
        ],
      }),
    );
    expect(normalizeStoredRow(once)).toEqual(once);
  });

  it("pairId など他のフィールドは残す", () => {
    const after = normalizeStoredRow({ ...row({}), pairId: "p-9", engine: "gemini" as const });
    expect(after).toMatchObject({ pairId: "p-9", engine: "gemini" });
  });
});
