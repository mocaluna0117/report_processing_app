import { describe, expect, it } from "vitest";
import {
  EXAMPLES_DELETED_MAX,
  type SharedExamples,
  emptySharedExamples,
  mergeSharedExamples,
  pickSharedExamples,
  toSharedExamples,
} from "@/lib/shared/examples";
import type { InquiryExample } from "@/lib/summarize/examples";

// 学習した書き方を2台で突き合わせる規則（2026-09-22）。
// ★消した印が無いと「消したのにファイルから戻ってくる」が起きる。
// 中身は伏せ字済みの本文だけ（実名・電話・住所は入れない）。

const ex = (id: string, output: string, updatedAt: number): InquiryExample => ({
  id,
  input: "浴室の換気扇から異音がする",
  output,
  createdAt: 100,
  updatedAt,
});

const shared = (items: InquiryExample[], deleted: Record<string, number> = {}): SharedExamples => ({
  items,
  deleted,
});

describe("突き合わせ", () => {
  it("同じ id は更新が新しい方を採る", () => {
    const a = shared([ex("c-1", "古い書き方", 10)]);
    const b = shared([ex("c-1", "新しい書き方", 20)]);
    expect(mergeSharedExamples(a, b).items).toEqual([ex("c-1", "新しい書き方", 20)]);
    expect(mergeSharedExamples(b, a).items).toEqual([ex("c-1", "新しい書き方", 20)]);
  });

  it("別の id は両方残る", () => {
    const merged = mergeSharedExamples(shared([ex("c-1", "Aの分", 10)]), shared([ex("c-2", "Bの分", 20)]));
    expect(merged.items.map((i) => i.id).sort()).toEqual(["c-1", "c-2"]);
  });

  it("★消した印より古い手本は落とす（消したのに戻ってこない）", () => {
    const a = shared([ex("c-1", "消される", 10)]);
    const b = shared([], { "c-1": 20 });
    expect(mergeSharedExamples(a, b).items).toEqual([]);
    expect(mergeSharedExamples(b, a).items).toEqual([]);
    // 印は残す（まだ相手が知らないかもしれないため）
    expect(mergeSharedExamples(a, b).deleted).toEqual({ "c-1": 20 });
  });

  it("★消したあとに学習し直せば復活する", () => {
    const deletedThen = shared([], { "c-1": 20 });
    const relearned = shared([ex("c-1", "覚え直した", 30)]);
    expect(mergeSharedExamples(deletedThen, relearned).items).toEqual([ex("c-1", "覚え直した", 30)]);
  });

  it("消した時刻と同じ更新の手本は落とす（消したあとに戻らない）", () => {
    expect(mergeSharedExamples(shared([ex("c-1", "同時刻", 20)]), shared([], { "c-1": 20 })).items).toEqual([]);
  });

  it("印は id ごとに新しい方を残す", () => {
    const merged = mergeSharedExamples(shared([], { "c-1": 10 }), shared([], { "c-1": 30 }));
    expect(merged.deleted).toEqual({ "c-1": 30 });
  });
});

describe("★どちらが先でも同じ結果で、重ねても変わらない", () => {
  const a = shared([ex("c-1", "Aの分", 10), ex("c-3", "Aだけ", 5)], { "c-9": 7 });
  const b = shared([ex("c-1", "Bの分", 20), ex("c-2", "Bだけ", 15)], { "c-3": 25 });

  it("可換", () => {
    expect(mergeSharedExamples(a, b)).toEqual(mergeSharedExamples(b, a));
  });

  it("冪等", () => {
    const once = mergeSharedExamples(a, b);
    expect(mergeSharedExamples(once, b)).toEqual(once);
    expect(mergeSharedExamples(once, a)).toEqual(once);
    expect(mergeSharedExamples(once, once)).toEqual(once);
  });

  it("消した印が勝った手本は入らない", () => {
    const once = mergeSharedExamples(a, b);
    expect(once.items.map((i) => i.id).sort()).toEqual(["c-1", "c-2"]);
    expect(once.items.find((i) => i.id === "c-1")?.output).toBe("Bの分");
  });
});

describe("際限なく伸びないようにする", () => {
  it("消した印が多すぎたら、古いものから落とす", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < EXAMPLES_DELETED_MAX + 10; i++) many[`c-${i}`] = i + 1;
    const merged = mergeSharedExamples(shared([], many), emptySharedExamples());
    expect(Object.keys(merged.deleted)).toHaveLength(EXAMPLES_DELETED_MAX);
    // 新しい印が残る
    expect(merged.deleted[`c-${EXAMPLES_DELETED_MAX + 9}`]).toBeDefined();
    expect(merged.deleted["c-0"]).toBeUndefined();
  });

  it("手本の上限は今までと同じ規則（両方を合わせて超えたら、更新の古いものから落ちる）", () => {
    const mine = [ex("c-1", "自分の古い", 1), ex("c-2", "自分の新しい", 40)];
    const theirs = [ex("c-3", "相手の新しい", 30), ex("c-4", "相手のもっと新しい", 50)];
    const merged = mergeSharedExamples(shared(mine), shared(theirs), 3);
    expect(merged.items).toHaveLength(3);
    // 更新がいちばん古い c-1 が落ちる
    expect(merged.items.map((i) => i.id).sort()).toEqual(["c-2", "c-3", "c-4"]);
  });
});

describe("読み方・作り方", () => {
  it("形の違う手本だけを落として読む", () => {
    const raw = { items: [ex("c-1", "生きている", 10), { id: "c-2" }, null], deleted: { "c-3": 5, "c-4": "文字列" } };
    const picked = pickSharedExamples(raw);
    expect(picked.items.map((i) => i.id)).toEqual(["c-1"]);
    expect(picked.deleted).toEqual({ "c-3": 5 });
  });

  it("そもそも形が違えば空として読む", () => {
    expect(pickSharedExamples(null)).toEqual(emptySharedExamples());
    expect(pickSharedExamples([1])).toEqual(emptySharedExamples());
  });

  it("この端末の一覧と印から共有の形を作る（元の配列は変えない）", () => {
    const items = [ex("c-1", "本文", 10)];
    const made = toSharedExamples(items, { "c-2": 5 });
    made.items.push(ex("c-9", "追加", 1));
    expect(items).toHaveLength(1);
    expect(made.deleted).toEqual({ "c-2": 5 });
  });
});
