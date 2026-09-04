import { describe, expect, it } from "vitest";
import {
  EXAMPLES_PICK_DEFAULT,
  type InquiryExample,
  buildExample,
  exampleOutputLines,
  exampleSection,
  isInquiryExampleLike,
  mergeExamples,
  redactExamples,
  sanitizeExamples,
  selectInquiryExamples,
  upsertExample,
} from "@/lib/summarize/examples";
import { buildInquiryPrompt } from "@/lib/summarize/inquiry";

const example = (over: Partial<InquiryExample> = {}): InquiryExample => ({
  id: "c-1",
  input: "浴室の換気扇から異音がするとのこと",
  output: "浴室の換気扇から異音",
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

describe("selectInquiryExamples", () => {
  const fan = example({ id: "fan", input: "浴室の換気扇から異音がするとのこと", output: "浴室換気扇から異音" });
  const window_ = example({
    id: "window",
    input: "2階洋室の窓が閉まりにくいとのこと",
    output: "2階洋室の窓が閉まりにくい",
    createdAt: 2_000,
    updatedAt: 2_000,
  });

  it("受付メモに近い手本を先に選ぶ", () => {
    const picked = selectInquiryExamples("換気扇から異音がする", [window_, fan], { max: 1 });
    expect(picked.map((e) => e.id)).toEqual(["fan"]);
  });

  it("件数の上限を守る", () => {
    const picked = selectInquiryExamples("窓が閉まらない", [fan, window_], { max: 1 });
    expect(picked).toHaveLength(1);
  });

  it("合計文字数の上限で打ち切る", () => {
    const big = (id: string, createdAt: number) =>
      example({ id, input: "あ".repeat(1000), output: "い".repeat(100), createdAt, updatedAt: createdAt });
    const picked = selectInquiryExamples("あああ", [big("a", 1), big("b", 2), big("c", 3)], {
      maxChars: 2500,
    });
    expect(picked).toHaveLength(2);
  });

  it("1件目が上限を超えていても手本ゼロにはしない", () => {
    const huge = example({ input: "あ".repeat(1500), output: "い".repeat(600) });
    expect(selectInquiryExamples("あ", [huge], { maxChars: 10 })).toHaveLength(1);
  });

  it("戻り値は古い順 (最後の手本が受付メモの近くに来る)", () => {
    const picked = selectInquiryExamples("窓が閉まらない", [window_, fan]);
    expect(picked.map((e) => e.createdAt)).toEqual([1_000, 2_000]);
  });

  it("話題が重ならなくても最近の手本を返す (文体は学べる)", () => {
    const picked = selectInquiryExamples("XYZ", [fan, window_], { max: 1 });
    expect(picked.map((e) => e.id)).toEqual(["window"]);
  });

  it("全角・空白の違いは似かよりに影響しない", () => {
    const half = selectInquiryExamples("2階洋室の窓", [fan, window_], { max: 1 });
    const full = selectInquiryExamples("２階 洋室の窓", [fan, window_], { max: 1 });
    expect(full.map((e) => e.id)).toEqual(half.map((e) => e.id));
    expect(full.map((e) => e.id)).toEqual(["window"]);
  });

  it("手本が無ければ空", () => {
    expect(selectInquiryExamples("窓", [])).toEqual([]);
  });

  it("既定の件数は8件", () => {
    expect(EXAMPLES_PICK_DEFAULT).toBe(8);
    const many = Array.from({ length: 20 }, (_, i) =>
      example({ id: `e${i}`, createdAt: i, updatedAt: i }),
    );
    expect(selectInquiryExamples("換気扇", many, { maxChars: 100_000 })).toHaveLength(8);
  });
});

describe("upsertExample / mergeExamples", () => {
  it("同じ id は差し替え、学習した日時は保つ", () => {
    const list = [example()];
    const next = upsertExample(list, { ...example(), output: "直した本文", updatedAt: 5_000 });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ output: "直した本文", createdAt: 1_000, updatedAt: 5_000 });
  });

  it("上限を超えたら更新が古いものから落とす", () => {
    const list = [
      example({ id: "old", createdAt: 1, updatedAt: 1 }),
      example({ id: "mid", createdAt: 2, updatedAt: 2 }),
    ];
    const next = upsertExample(list, example({ id: "new", createdAt: 3, updatedAt: 3 }), 2);
    expect(next.map((e) => e.id)).toEqual(["mid", "new"]);
  });

  it("取り込みは同じ id の新しい方を採る", () => {
    const current = [example({ output: "古い本文", updatedAt: 1_000 })];
    expect(mergeExamples(current, [example({ output: "新しい本文", updatedAt: 2_000 })])[0]).toMatchObject(
      { output: "新しい本文" },
    );
    expect(mergeExamples(current, [example({ output: "さらに古い", updatedAt: 500 })])[0]).toMatchObject(
      { output: "古い本文" },
    );
  });
});

describe("exampleOutputLines", () => {
  it("①②③の番号を落として項目に分ける", () => {
    expect(exampleOutputLines("①浴室の換気扇から異音\n②2階洋室の窓が閉まりにくい")).toEqual([
      "浴室の換気扇から異音",
      "2階洋室の窓が閉まりにくい",
    ]);
  });

  it("番号が無い1件はそのまま", () => {
    expect(exampleOutputLines("浴室の換気扇から異音")).toEqual(["浴室の換気扇から異音"]);
  });

  it("(21) 形式も落とす", () => {
    expect(exampleOutputLines("(21)クロスの浮き")).toEqual(["クロスの浮き"]);
  });

  it("空行は落とす", () => {
    expect(exampleOutputLines("①A\n\n②B\n")).toEqual(["A", "B"]);
  });
});

describe("sanitizeExamples", () => {
  it("配列でなければ空", () => {
    expect(sanitizeExamples(undefined)).toEqual([]);
    expect(sanitizeExamples("x")).toEqual([]);
  });

  it("件数を12件までに抑える", () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({ input: `in${i}`, output: `out${i}` }));
    expect(sanitizeExamples(raw)).toHaveLength(12);
  });

  it("長すぎる本文を切り詰める", () => {
    const [out] = sanitizeExamples([{ input: "あ".repeat(3000), output: "い".repeat(2000) }]);
    expect(out.input).toHaveLength(1500);
    expect(out.output).toHaveLength(600);
  });

  it("制御文字を落とす", () => {
    const [out] = sanitizeExamples([
      { input: `受付${String.fromCharCode(7)}メモ`, output: "本文" },
    ]);
    expect(out.input).toBe("受付メモ");
  });

  it("片方が空・文字列でないものは捨てる", () => {
    expect(sanitizeExamples([{ input: "", output: "本文" }])).toEqual([]);
    expect(sanitizeExamples([{ input: "メモ", output: "  " }])).toEqual([]);
    expect(sanitizeExamples([{ input: 1, output: "本文" }])).toEqual([]);
  });

  it("同じ組は1つにまとめる", () => {
    const raw = [
      { input: "メモ", output: "本文" },
      { input: "メモ", output: "本文" },
    ];
    expect(sanitizeExamples(raw)).toHaveLength(1);
  });
});

describe("redactExamples", () => {
  it("手本の本文からも氏名・電話・住所を伏せる", () => {
    const [out] = redactExamples([
      {
        input: "田中さんより入電。東京都架空区北町1-2-3 の換気扇。090-0000-1234",
        output: "浴室の換気扇から異音 (田中様宅)",
      },
    ]);
    expect(out.input).not.toContain("田中");
    expect(out.input).not.toContain("090-0000-1234");
    expect(out.input).not.toContain("架空区北町");
    expect(out.output).not.toContain("田中");
  });
});

describe("buildInquiryPrompt の手本", () => {
  const examples = [{ input: "換気扇がうるさいとの連絡", output: "①浴室の換気扇から異音\n②窓の建付け不良" }];

  it("手本を渡すと受付メモの前に手本の節が入る", () => {
    const prompt = buildInquiryPrompt("今回のメモ", examples);
    expect(prompt).toContain("過去の例");
    expect(prompt).toContain("換気扇がうるさいとの連絡");
    expect(prompt).toContain("- 浴室の換気扇から異音");
    expect(prompt).toContain("- 窓の建付け不良");
    // 番号はサーバー側で振り直すので手本には残さない
    expect(prompt).not.toContain("①浴室");
    expect(prompt.indexOf("過去の例")).toBeLessThan(prompt.indexOf("## 受付メモ"));
  });

  it("手本を渡さなければ従来のプロンプトのまま", () => {
    const prompt = buildInquiryPrompt("今回のメモ");
    expect(prompt).not.toContain("過去の例");
  });

  it("手本があっても既存の条件文は残る", () => {
    const prompt = buildInquiryPrompt("今回のメモ", examples);
    expect(prompt).toContain("## 受付メモ");
    expect(prompt).toContain("phenomena");
    expect(prompt).toContain("requests");
    expect(prompt).toContain("対応方針・訪問日程・折り返しの約束は入れない");
  });
});

describe("isInquiryExampleLike", () => {
  it("学習1件の形だけを通す", () => {
    expect(isInquiryExampleLike(example())).toBe(true);
    expect(isInquiryExampleLike({ id: "a", input: "b", output: "c" })).toBe(false);
    expect(isInquiryExampleLike(null)).toBe(false);
  });
});

describe("exampleSection (画面ごとの呼び名)", () => {
  const examples = [{ input: "1. 場所: 1階 洋室 / 部位: クロス", output: "①1階洋室のクロスに凹凸" }];

  it("定期点検は「不具合項目 → 点検内容」で並べる", () => {
    const lines = exampleSection(examples, { input: "不具合項目", output: "点検内容" }).join("\n");
    expect(lines).toContain("過去の例");
    expect(lines).toContain("不具合項目:");
    expect(lines).toContain("点検内容:");
    expect(lines).toContain("- 1階洋室のクロスに凹凸");
    // 番号はサーバー側で振り直すので手本には残さない
    expect(lines).not.toContain("①1階");
  });

  it("手本が無ければ何も出さない", () => {
    expect(exampleSection([], { input: "不具合項目", output: "点検内容" })).toEqual([]);
  });
});

describe("buildExample", () => {
  it("入力・出力のどちらも伏せ字にする", () => {
    const { input, output } = buildExample(
      "1. 場所: 1階 洋室 / 症状: 凹凸\n   備考: 山田様より 090-0000-1234",
      "1階洋室のクロスに凹凸 (山田様宅)",
    );
    expect(input).toContain("1階 洋室");
    expect(input).not.toContain("山田");
    expect(input).not.toContain("090-0000-1234");
    expect(output).not.toContain("山田");
    expect(output).toContain("1階洋室のクロスに凹凸");
  });

  it("長すぎる本文は切り詰める", () => {
    const { input, output } = buildExample("あ".repeat(3000), "い".repeat(2000));
    expect(input).toHaveLength(1500);
    expect(output).toHaveLength(600);
  });

  it("空の入力・出力はそのまま空 (学習ボタンを押せないようにするため)", () => {
    expect(buildExample("", "")).toEqual({ input: "", output: "" });
  });
});
