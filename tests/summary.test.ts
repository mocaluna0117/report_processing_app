import { describe, expect, it } from "vitest";
import { NO_DEFECT_TEXT } from "@/lib/summarize/format";
import {
  attachSummaries,
  categoryItemGroups,
  distributeSummary,
  isSummarySplit,
  joinSummary,
  mergeSplitSummary,
  recordSummary,
  splitInstructionItems,
  splitSummary,
  syncSummaryCell,
  withDistributedSummaries,
  withoutSupplements,
} from "@/lib/summary";
import { COLUMNS, SUMMARY_COL } from "@/lib/tsv";

const cellsWith = (summary: string) =>
  COLUMNS.map((c, i) => (i === SUMMARY_COL ? summary : `v:${c}`));

describe("distributeSummary", () => {
  it("事象を工事区分のキーワードで振り分ける (1件だけの行は番号なし)", () => {
    const texts = distributeSummary(
      "①1階洋室天井のクロスに凹凸\n②2階サッシの結露",
      ["クロス", "サッシ"],
    );
    expect(texts).toEqual(["1階洋室天井のクロスに凹凸", "2階サッシの結露"]);
  });

  it("同じ区分に2件以上入る行は①から振り直す", () => {
    const texts = distributeSummary(
      "①1階洋室のクロスに凹凸\n②2階リビングの壁紙に浮き\n③玄関サッシの建付け不良",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("①1階洋室のクロスに凹凸\n②2階リビングの壁紙に浮き");
    expect(texts[1]).toBe("玄関サッシの建付け不良");
  });

  it("どの区分にも当たらない事象は「その他」の行へ", () => {
    const texts = distributeSummary(
      "①クロスに凹凸\n②2階階段ササラ仕上げの剥がれ",
      ["クロス", "その他"],
    );
    expect(texts[0]).toBe("クロスに凹凸");
    expect(texts[1]).toBe("2階階段ササラ仕上げの剥がれ");
  });

  it("「その他」が無ければ先頭の行へ", () => {
    const texts = distributeSummary(
      "①玄関サッシの建付け不良\n②2階階段ササラ仕上げの剥がれ",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("2階階段ササラ仕上げの剥がれ");
    expect(texts[1]).toBe("玄関サッシの建付け不良");
  });

  it("点検員メモは先頭の行にだけ付ける (事象として数えない)", () => {
    const texts = distributeSummary(
      "①クロスに凹凸\n②サッシの結露\nメモ: 次回は奥様が立ち会い",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("クロスに凹凸\nメモ: 次回は奥様が立ち会い");
    expect(texts[1]).toBe("サッシの結露");
  });

  it("「指摘なし」の定型文は先頭の行にだけ残す", () => {
    const texts = distributeSummary(NO_DEFECT_TEXT, ["クロス", "サッシ"]);
    expect(texts).toEqual([NO_DEFECT_TEXT, ""]);
  });

  it("空の本文なら全行が空欄 (戻り値の数は区分の数と同じ)", () => {
    expect(distributeSummary("", ["クロス", "サッシ", "その他"])).toEqual(["", "", ""]);
  });

  it("同じ区分が2つあれば先頭の方へ入れる", () => {
    const texts = distributeSummary("①クロスに凹凸\n②壁紙に浮き", ["クロス", "クロス"]);
    expect(texts[0]).toBe("①クロスに凹凸\n②壁紙に浮き");
    expect(texts[1]).toBe("");
  });

  it("空欄の区分はキーワード一致の対象にせず、当たらない事象だけ先頭に入る", () => {
    const texts = distributeSummary("①サッシの結露\n②原因不明の異音", ["", "サッシ"]);
    expect(texts[0]).toBe("原因不明の異音");
    expect(texts[1]).toBe("サッシの結露");
  });
});

describe("mergeSplitSummary", () => {
  it("区分の順に並べて①②③を振り直す", () => {
    const text = mergeSplitSummary([
      { summary: "①クロスに凹凸\n②壁紙に浮き" },
      { summary: "サッシの結露" },
    ]);
    expect(text).toBe("①クロスに凹凸\n②壁紙に浮き\n③サッシの結露");
  });

  it("同じメモが複数行にあっても1つにまとめて末尾に置く", () => {
    const text = mergeSplitSummary([
      { summary: "クロスに凹凸\nメモ: 奥様立ち会い" },
      { summary: "サッシの結露\nメモ: 奥様立ち会い" },
    ]);
    expect(text).toBe("①クロスに凹凸\n②サッシの結露\nメモ: 奥様立ち会い");
  });

  it("すべて空で定型文だけならその定型文に戻す", () => {
    expect(mergeSplitSummary([{ summary: NO_DEFECT_TEXT }, { summary: "" }])).toBe(NO_DEFECT_TEXT);
  });
});

describe("recordSummary", () => {
  it("工事区分が1件以下ならセルの値をそのまま返す", () => {
    const row = {
      cells: cellsWith("①クロスに凹凸\n②サッシの結露"),
      categories: [{ value: "クロス", summary: "A" }],
    };
    expect(recordSummary(row)).toBe("①クロスに凹凸\n②サッシの結露");
    expect(recordSummary({ cells: cellsWith("本文"), categories: [] })).toBe("本文");
  });

  it("工事区分が2件以上なら全区分をまとめたものを返す", () => {
    const row = {
      cells: cellsWith("鏡になっていない古い本文"),
      categories: [
        { value: "クロス", summary: "クロスに凹凸" },
        { value: "サッシ", summary: "サッシの結露" },
      ],
    };
    expect(recordSummary(row)).toBe("①クロスに凹凸\n②サッシの結露");
  });

  it("本文が無い区分は空として扱う", () => {
    const row = {
      cells: cellsWith("分ける前の本文"),
      categories: [{ value: "クロス", summary: "クロスに凹凸" }, { value: "サッシ" }],
    };
    expect(recordSummary(row)).toBe("クロスに凹凸");
  });
});

describe("isSummarySplit", () => {
  const cells = cellsWith("本文");
  it("工事区分が2件以上なら分割中 (切り替えのフラグは無い)", () => {
    expect(isSummarySplit({ cells, categories: [{ value: "a" }, { value: "b" }] })).toBe(true);
  });

  it("工事区分が1件以下なら分割扱いにしない", () => {
    expect(isSummarySplit({ cells, categories: [{ value: "a" }] })).toBe(false);
    expect(isSummarySplit({ cells, categories: [] })).toBe(false);
    expect(isSummarySplit({ cells })).toBe(false);
  });
});

describe("withDistributedSummaries", () => {
  it("2件以上なら本文を振り分けて各区分に付ける", () => {
    const next = withDistributedSummaries(
      [
        { value: "クロス", confidence: "ok" as const },
        { value: "サッシ", confidence: "warn" as const, item: "外部建具" },
      ],
      "①1階洋室のクロスに凹凸\n②玄関サッシの結露",
    );
    expect(next.map((c) => c.summary)).toEqual(["1階洋室のクロスに凹凸", "玄関サッシの結露"]);
    // 判定の情報 (confidence・item) は落とさない
    expect(next[1]).toMatchObject({ confidence: "warn", item: "外部建具" });
  });

  it("1件以下なら残っていた本文を外す", () => {
    expect(withDistributedSummaries([{ value: "クロス", summary: "古い本文" }], "本文")).toEqual([
      { value: "クロス" },
    ]);
  });

  it("本文が空なら全区分が空欄", () => {
    const next = withDistributedSummaries([{ value: "クロス" }, { value: "サッシ" }], "");
    expect(next.map((c) => c.summary)).toEqual(["", ""]);
  });
});

describe("syncSummaryCell", () => {
  it("2件以上なら共通のセルを各行の本文の鏡にする", () => {
    const cells = cellsWith("古い本文");
    const next = syncSummaryCell(cells, [{ summary: "クロスに凹凸" }, { summary: "サッシの結露" }]);
    expect(next[SUMMARY_COL]).toBe("①クロスに凹凸\n②サッシの結露");
    // 他の列は触らない
    expect(next.filter((_, i) => i !== SUMMARY_COL)).toEqual(
      cells.filter((_, i) => i !== SUMMARY_COL),
    );
  });

  it("1件以下・既に鏡なら同じ配列を返す (保存の書き込みを増やさない)", () => {
    const cells = cellsWith("本文");
    expect(syncSummaryCell(cells, [{ summary: "本文" }])).toBe(cells);
    const mirrored = cellsWith("①A\n②B");
    expect(syncSummaryCell(mirrored, [{ summary: "A" }, { summary: "B" }])).toBe(mirrored);
  });
});

describe("attachSummaries", () => {
  it("共通のセルを振り分けて各行に持たせ、セルは鏡になる", () => {
    const { cells, categories } = attachSummaries(
      cellsWith("①1階洋室天井のクロスに凹凸\n②2階サッシの結露"),
      [
        { value: "クロス", confidence: "ok" as const, item: "クロス" },
        { value: "サッシ", confidence: "warn" as const },
      ],
    );
    expect(categories.map((c) => c.summary)).toEqual([
      "1階洋室天井のクロスに凹凸",
      "2階サッシの結露",
    ]);
    expect(categories[0]).toMatchObject({ confidence: "ok", item: "クロス" });
    expect(cells[SUMMARY_COL]).toBe("①1階洋室天井のクロスに凹凸\n②2階サッシの結露");
  });

  it("要約が取れなかったときは全行が空欄", () => {
    const { cells, categories } = attachSummaries(cellsWith(""), [
      { value: "クロス" },
      { value: "サッシ" },
    ]);
    expect(categories.map((c) => c.summary)).toEqual(["", ""]);
    expect(cells[SUMMARY_COL]).toBe("");
  });
});

describe("categoryItemGroups", () => {
  const categories = [
    { value: "クロス", summary: "①クロスに凹凸\n②壁紙に浮き\nメモ: 立ち会いあり" },
    { value: "", summary: "原因不明の異音" },
  ];

  it("区分ごとの項目・メモに分け、書き戻し先の添字を持つ", () => {
    const groups = categoryItemGroups(categories);
    expect(groups.map((g) => g.catIndex)).toEqual([0, 1]);
    expect(groups[0].parts.items).toEqual(["クロスに凹凸", "壁紙に浮き"]);
    expect(groups[0].parts.notes).toEqual(["立ち会いあり"]);
    expect(groups[1].category).toBe("");
  });

  it("項目の並びは完了報告書の指示内容と同じ (番号を通しで振れる)", () => {
    const groups = categoryItemGroups(categories);
    expect(groups.flatMap((g) => g.parts.items)).toEqual(
      splitInstructionItems(mergeSplitSummary(categories)),
    );
  });
});

describe("補足 (補足: の行)", () => {
  it("項目の次の「補足: 」の行はその項目の補足になる", () => {
    const parts = splitSummary("①壁のひび\n補足: 3階の north 側\n②床のきしみ");
    expect(parts.items).toEqual(["壁のひび", "床のきしみ"]);
    expect(parts.supplements).toEqual([["3階の north 側"], []]);
  });

  it("全角コロンでも読める", () => {
    expect(splitSummary("壁のひび\n補足：写真2枚目").supplements).toEqual([["写真2枚目"]]);
  });

  it("★同じ項目に補足が何行もあれば、1行ずつ別の補足として読む（2026-09-25。前は1つにまとめて2つ目から消えていた）", () => {
    expect(splitSummary("壁のひび\n補足: 前半\n補足: 後半").supplements).toEqual([["前半", "後半"]]);
  });

  it("★前に1行にまとめて保存した「A　B」は、そのまま1つとして読む（全角空白で割らない）", () => {
    expect(splitSummary("壁のひび\n補足: 前半　後半").supplements).toEqual([["前半　後半"]]);
  });

  it("★先頭に打った「・」は落として読む（報告書で「・・」にならないように）", () => {
    expect(splitSummary("壁のひび\n補足: ・床鳴り").supplements).toEqual([["床鳴り"]]);
  });

  it("★補足が2つある本文を読んで書き戻すと、元の本文に戻る（何回くり返しても同じ）", () => {
    const text = "①壁のひび\n補足: 3階北側\n補足: 写真は3枚目\n②床のきしみ\n補足: 1階廊下\nメモ: 奥様が立ち会い";
    expect(joinSummary(splitSummary(text))).toBe(text);
    expect(joinSummary(splitSummary(joinSummary(splitSummary(text))))).toBe(text);
  });

  it("★項目より前にある補足の行は、失わないよう普通の項目として扱う", () => {
    const parts = splitSummary("補足: 迷子の行\n①壁のひび");
    expect(parts.items).toEqual(["迷子の行", "壁のひび"]);
    expect(parts.supplements).toEqual([[], []]);
  });

  it("書き戻すと同じ本文に戻る", () => {
    const text = "①壁のひび\n補足: 3階北側\n②床のきしみ\nメモ: 奥様が立ち会い";
    expect(joinSummary(splitSummary(text))).toBe(text);
  });

  it("★工事区分に振り分けても補足は元の項目についていく", () => {
    const texts = distributeSummary(
      "①クロスに凹凸\n補足: 3か所\n②サッシの結露\n補足: 北側のみ",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("クロスに凹凸\n補足: 3か所");
    expect(texts[1]).toBe("サッシの結露\n補足: 北側のみ");
  });

  it("★補足が2つあっても、振り分け・まとめ直しで保たれる", () => {
    const texts = distributeSummary(
      "①クロスに凹凸\n補足: 3か所\n補足: 写真2枚目\n②サッシの結露\n補足: 北側のみ",
      ["クロス", "サッシ"],
    );
    expect(texts[0]).toBe("クロスに凹凸\n補足: 3か所\n補足: 写真2枚目");
    expect(mergeSplitSummary(texts.map((summary) => ({ summary })))).toBe(
      "①クロスに凹凸\n補足: 3か所\n補足: 写真2枚目\n②サッシの結露\n補足: 北側のみ",
    );
  });

  it("★分けた本文をまとめ直しても補足が保たれる", () => {
    const merged = mergeSplitSummary([
      { summary: "クロスに凹凸\n補足: 3か所" },
      { summary: "サッシの結露" },
    ]);
    expect(merged).toBe("①クロスに凹凸\n補足: 3か所\n②サッシの結露");
  });

  it("学習の手本からは補足の行を外す (要約が補足を作り出さないように)", () => {
    expect(withoutSupplements("①壁のひび\n補足: 3か所\n②床のきしみ")).toBe(
      "①壁のひび\n②床のきしみ",
    );
  });

  it("指示内容の項目だけを取るときは今までどおり (補足は混ざらない)", () => {
    expect(splitInstructionItems("①壁のひび\n補足: 3か所\n②床のきしみ")).toEqual([
      "壁のひび",
      "床のきしみ",
    ]);
  });
});
