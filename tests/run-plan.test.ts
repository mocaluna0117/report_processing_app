import { describe, expect, it } from "vitest";
import type { PairView } from "@/components/pair-table";
import type { ResultRow } from "@/lib/process";
import { DEFAULT_REPORT_OPTIONS } from "@/lib/report/model";
import {
  canRun,
  defaultSelection,
  orderRowsByPairs,
  orphanRowIds,
  pairKey,
  pairStates,
  reconcilePairs,
  reconcileSelection,
  selectionCounts,
  upsertRow,
  visibleRows,
} from "@/lib/run-plan";
import { COLUMNS } from "@/lib/tsv";

const pair = (over: Partial<PairView> & { id: string }): PairView => ({
  photoId: null,
  inspectionId: null,
  date: "20260722",
  ownerDisplay: "山田 太郎",
  needsReview: false,
  ...over,
});

const row = (pairId: string, over: Partial<ResultRow> = {}): ResultRow => ({
  pairId,
  ownerDisplay: "山田 太郎",
  cells: COLUMNS.map(() => ""),
  confidences: COLUMNS.map(() => "ok" as const),
  categories: [],
  categoryEngine: "none",
  report: DEFAULT_REPORT_OPTIONS,
  mail: { ownerKana: "", kanaConfidence: "ok", kanaAlternatives: [], contacts: [] },
  warnings: [],
  engine: null,
  merged: null,
  mergedName: `${pairId}.pdf`,
  error: null,
  ...over,
});

describe("reconcilePairs", () => {
  const newId = () => "p-new";

  it("同じ写真報告書を指すペアはIDを引き継ぐ (前回の結果が外れない)", () => {
    const prev = [pair({ id: "p-1", photoId: "f-photo", inspectionId: "f-insp" })];
    const next = [
      { photoId: "f-photo", inspectionId: "f-insp", date: "20260722", ownerDisplay: "山田 太郎", needsReview: false },
    ];
    expect(reconcilePairs(prev, next, newId)[0].id).toBe("p-1");
  });

  it("点検報告書が後から見つかってもIDは変わらない", () => {
    const prev = [pair({ id: "p-1", photoId: "f-photo", inspectionId: null })];
    const next = [
      { photoId: "f-photo", inspectionId: "f-insp", date: "20260722", ownerDisplay: "山田 太郎", needsReview: false },
    ];
    const [merged] = reconcilePairs(prev, next, newId);
    expect(merged.id).toBe("p-1");
    expect(merged.inspectionId).toBe("f-insp");
  });

  it("新しいファイルのペアには新しいIDを振る", () => {
    const prev = [pair({ id: "p-1", photoId: "f-photo", inspectionId: null })];
    const next = [
      { photoId: "f-photo", inspectionId: null, date: "20260722", ownerDisplay: "山田 太郎", needsReview: false },
      { photoId: "f-photo2", inspectionId: null, date: "20260730", ownerDisplay: "佐藤 花子", needsReview: false },
    ];
    expect(reconcilePairs(prev, next, newId).map((p) => p.id)).toEqual(["p-1", "p-new"]);
  });

  it("写真の無いペア (相手待ちの点検報告書) は点検報告書で引き継ぐ", () => {
    const prev = [pair({ id: "p-1", photoId: null, inspectionId: "f-insp" })];
    const next = [
      { photoId: null, inspectionId: "f-insp", date: "20260722", ownerDisplay: "山田 太郎", needsReview: false },
    ];
    expect(reconcilePairs(prev, next, newId)[0].id).toBe("p-1");
  });

  it("同じIDを2つのペアに割り当てない", () => {
    const prev = [
      pair({ id: "p-1", photoId: "f-photo", inspectionId: "f-insp" }),
      pair({ id: "p-2", photoId: null, inspectionId: "f-insp2" }),
    ];
    let n = 0;
    const next = [
      { photoId: "f-photo", inspectionId: null, date: "20260722", ownerDisplay: "山田 太郎", needsReview: false },
      { photoId: null, inspectionId: "f-insp", date: "20260722", ownerDisplay: "山田 太郎", needsReview: false },
    ];
    const ids = reconcilePairs(prev, next, () => `p-gen${++n}`).map((p) => p.id);
    expect(ids).toEqual(["p-1", "p-gen1"]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("pairStates / defaultSelection", () => {
  it("結果が無いペアは未処理、あるペアは処理済み", () => {
    const pairs = [
      pair({ id: "p-1", photoId: "f-1" }),
      pair({ id: "p-2", photoId: "f-2", date: "20260730", ownerDisplay: "佐藤 花子" }),
    ];
    const states = pairStates(pairs, [row("p-1")]);
    expect(states.get("p-1")).toBe("processed");
    expect(states.get("p-2")).toBe("unprocessed");
    expect([...defaultSelection(states)]).toEqual(["p-2"]);
  });

  it("失敗した行は未処理と同じ扱いで選び直せる", () => {
    const pairs = [pair({ id: "p-1", photoId: "f-1" })];
    const states = pairStates(pairs, [row("p-1", { error: "処理に失敗しました" })]);
    expect(states.get("p-1")).toBe("failed");
    expect(defaultSelection(states).has("p-1")).toBe(true);
  });

  it("写真報告書が無いペアは処理できない (チェックもしない)", () => {
    const pairs = [pair({ id: "p-1", photoId: null, inspectionId: "f-insp" })];
    const states = pairStates(pairs, []);
    expect(states.get("p-1")).toBe("no-photo");
    expect(defaultSelection(states).size).toBe(0);
    expect(canRun("no-photo")).toBe(false);
    expect(canRun("processed")).toBe(true);
  });

  it("同じ施主・点検日の処理済みがあれば重複として既定では選ばない", () => {
    const pairs = [
      pair({ id: "p-1", photoId: "f-1" }),
      // 再ダウンロードした「 (1)」付きの写真報告書で作られたペア
      pair({ id: "p-2", photoId: "f-1b" }),
    ];
    const states = pairStates(pairs, [row("p-1")]);
    expect(states.get("p-2")).toBe("duplicate");
    expect(defaultSelection(states).has("p-2")).toBe(false);
  });

  it("失敗した行しかなければ重複にしない (やり直せる)", () => {
    const pairs = [
      pair({ id: "p-1", photoId: "f-1" }),
      pair({ id: "p-2", photoId: "f-1b" }),
    ];
    const states = pairStates(pairs, [row("p-1", { error: "失敗" })]);
    expect(states.get("p-2")).toBe("unprocessed");
  });

  it("施主名の空白の違いは同じ報告書とみなす", () => {
    expect(pairKey({ date: "20260722", ownerDisplay: "山田 太郎" })).toBe(
      pairKey({ date: "20260722", ownerDisplay: "山田　太郎" }),
    );
    expect(pairKey({ date: "20260722", ownerDisplay: "山田 太郎" })).not.toBe(
      pairKey({ date: "20260730", ownerDisplay: "山田 太郎" }),
    );
  });
});

describe("upsertRow / orderRowsByPairs", () => {
  const pairs = [{ id: "p-1" }, { id: "p-2" }, { id: "p-3" }];

  it("同じペアの結果は置き換える (行が増えない)", () => {
    const prev = [row("p-1", { ownerDisplay: "前" })];
    const next = upsertRow(prev, row("p-1", { ownerDisplay: "後" }));
    expect(next).toHaveLength(1);
    expect(next[0].ownerDisplay).toBe("後");
  });

  it("新しいペアの結果は足す", () => {
    expect(upsertRow([row("p-1")], row("p-2")).map((r) => r.pairId)).toEqual(["p-1", "p-2"]);
  });

  it("並びはペアリング結果に揃える", () => {
    const rows = [row("p-3"), row("p-1"), row("p-2")];
    expect(orderRowsByPairs(rows, pairs).map((r) => r.pairId)).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("ペアが無くなった行は消さずに末尾へ置く", () => {
    const rows = [row("p-old"), row("p-2")];
    expect(orderRowsByPairs(rows, pairs).map((r) => r.pairId)).toEqual(["p-2", "p-old"]);
    expect(orphanRowIds(rows, pairs)).toEqual(["p-old"]);
  });
});

describe("reconcileSelection / selectionCounts", () => {
  const pairs = [
    pair({ id: "p-1", photoId: "f-1" }),
    pair({ id: "p-2", photoId: "f-2", date: "20260730", ownerDisplay: "佐藤 花子" }),
    pair({ id: "p-3", photoId: null, inspectionId: "f-3" }),
  ];
  const states = pairStates(pairs, [row("p-1")]);

  it("自分で外したチェックはファイルを足しても戻らない", () => {
    const next = reconcileSelection({ previous: new Set(), states, add: [] });
    expect(next.size).toBe(0);
  });

  it("新しく現れたペアは足す", () => {
    const next = reconcileSelection({ previous: new Set(["p-2"]), states, add: ["p-1"] });
    expect([...next].sort()).toEqual(["p-1", "p-2"]);
  });

  it("重複の疑いがあるペアは、新しく現れても既定では選ばない", () => {
    const dup = [...pairs, pair({ id: "p-dup", photoId: "f-1b" })];
    const dupStates = pairStates(dup, [row("p-1")]);
    const next = reconcileSelection({ previous: new Set(), states: dupStates, add: ["p-dup"] });
    expect(next.has("p-dup")).toBe(false);
  });

  it("消えたペア・処理できないペアは落とす", () => {
    const next = reconcileSelection({
      previous: new Set(["p-2", "p-3", "p-gone"]),
      states,
      add: ["p-3"],
    });
    expect([...next]).toEqual(["p-2"]);
  });

  it("件数は 処理済み + 未処理 = 処理できるペア になる", () => {
    const counts = selectionCounts(states, new Set(["p-1", "p-2"]));
    expect(counts).toEqual({
      total: 3,
      runnable: 2,
      processed: 1,
      unprocessed: 1,
      selected: 2,
      selectedProcessed: 1,
    });
    expect(counts.processed + counts.unprocessed).toBe(counts.runnable);
  });
});

describe("visibleRows", () => {
  const rows = [row("p-1"), row("p-2"), row("p-3")];

  it("今回の分だけに絞れる", () => {
    expect(visibleRows(rows, "last", new Set(["p-2", "p-3"])).map((r) => r.pairId)).toEqual([
      "p-2",
      "p-3",
    ]);
  });

  it("すべてを選べば全件", () => {
    expect(visibleRows(rows, "all", new Set(["p-2"]))).toHaveLength(3);
  });

  it("まだ処理していない (再読み込み直後) なら全件を出す", () => {
    expect(visibleRows(rows, "last", new Set())).toHaveLength(3);
  });
});
