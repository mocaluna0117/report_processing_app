import { describe, expect, it } from "vitest";
import {
  FILENAME_EXAMPLE,
  type InspectionFlowInput,
  inspectionFlow,
  inspectionRunBlockedReason,
  isFreshInspection,
} from "@/lib/inspection-flow";
import { parseFileName } from "@/lib/pairing";
import type { SelectionCounts } from "@/lib/run-plan";

const counts = (over: Partial<SelectionCounts> = {}): SelectionCounts => ({
  total: 0,
  runnable: 0,
  processed: 0,
  unprocessed: 0,
  selected: 0,
  selectedProcessed: 0,
  ...over,
});

const input = (over: Partial<InspectionFlowInput> = {}): InspectionFlowInput => ({
  restored: true,
  processing: false,
  fileCount: 0,
  unclassifiedCount: 0,
  counts: counts(),
  needsReviewCount: 0,
  okRowCount: 0,
  ...over,
});

/** PDFを2組ドロップした直後（未処理は自動でチェックされる） */
const dropped = (over: Partial<InspectionFlowInput> = {}) =>
  input({
    fileCount: 4,
    counts: counts({ total: 2, runnable: 2, unprocessed: 2, selected: 2 }),
    ...over,
  });

describe("定期点検の手順", () => {
  it("初回はドロップの段。案内を出す", () => {
    const plan = inspectionFlow(input());
    expect(plan.currentId).toBe("drop");
    expect(plan.nextHint).toContain("まとめて、上の枠にドロップ");
    expect(plan.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(isFreshInspection(input())).toBe(true);
  });

  it("★種別を判定できないファイルだけのときは、ファイル名の決まりを例つきで出す", () => {
    const plan = inspectionFlow(input({ fileCount: 2, unclassifiedCount: 2 }));
    expect(plan.currentId).toBe("drop");
    expect(plan.nextHint).toContain("【写真報告書】");
    expect(plan.nextHint).toContain(FILENAME_EXAMPLE);
  });

  it("ドロップ直後は処理の段（未処理は自動でチェックされている）", () => {
    const plan = inspectionFlow(dropped());
    expect(plan.currentId).toBe("run");
    expect(plan.nextHint).toContain("「選択した2件を処理」");
    expect(plan.steps[0]).toMatchObject({ state: "done", note: "4ファイル" });
    expect(isFreshInspection(dropped())).toBe(false);
  });

  it("チェックを全部外すと、ペアの段に戻って理由を出す", () => {
    const plan = inspectionFlow(dropped({ counts: counts({ total: 2, runnable: 2, unprocessed: 2, selected: 0 }) }));
    expect(plan.currentId).toBe("pairs");
    expect(plan.nextHint).toContain("チェックを入れて");
  });

  it("★写真報告書が無い組だけなら、進められない印にする", () => {
    const plan = inspectionFlow(input({ fileCount: 1, counts: counts({ total: 1, runnable: 0 }) }));
    expect(plan.steps.find((s) => s.id === "pairs")?.state).toBe("blocked");
    expect(plan.nextHint).toContain("写真報告書");
  });

  it("要確認の組があれば数を出し、押す前に確かめるよう添える", () => {
    const plan = inspectionFlow(dropped({ needsReviewCount: 1 }));
    expect(plan.steps.find((s) => s.id === "pairs")?.note).toBe("要確認 1組");
    expect(plan.nextHint).toContain("要確認");
  });

  it("処理中は処理の段に「処理中…」を出す", () => {
    const plan = inspectionFlow(dropped({ processing: true }));
    expect(plan.steps.find((s) => s.id === "run")).toMatchObject({ state: "current", note: "処理中…" });
  });

  it("全部処理し終えたら、結果を使う段へ進む", () => {
    const plan = inspectionFlow(
      input({ fileCount: 4, counts: counts({ total: 2, runnable: 2, processed: 2 }), okRowCount: 2 }),
    );
    expect(plan.currentId).toBe("results");
    expect(plan.steps.find((s) => s.id === "results")?.note).toBe("2件");
    expect(plan.nextHint).toContain("Excel用にコピー");
  });

  it("読み込み中は進められない印にする", () => {
    expect(inspectionFlow(input({ restored: false })).steps[0].state).toBe("blocked");
    expect(isFreshInspection(input({ restored: false }))).toBe(false);
  });
});

describe("処理ボタンが押せない理由", () => {
  it("今までの吹き出しと同じ文を、見える文字で出す", () => {
    expect(inspectionRunBlockedReason(dropped({ counts: counts({ total: 2, runnable: 2, selected: 0 }) }))).toBe(
      "ペアリング結果でチェックを入れてください",
    );
  });

  it("写真報告書が無い・読み込み中もそれぞれ理由を出す", () => {
    expect(inspectionRunBlockedReason(input({ counts: counts({ total: 1, runnable: 0 }) }))).toContain("写真報告書");
    expect(inspectionRunBlockedReason(input({ restored: false }))).toContain("読み込んでいます");
  });

  it("押せるとき・処理中は理由を出さない", () => {
    expect(inspectionRunBlockedReason(dropped())).toBeNull();
    expect(inspectionRunBlockedReason(dropped({ processing: true }))).toBeNull();
  });
});

describe("ファイル名の例", () => {
  it("★例は実際に読める形にしておく（案内と取り込みの規則がずれない）", () => {
    expect(parseFileName(FILENAME_EXAMPLE)).toMatchObject({ kind: "photo", date: "20260722" });
    expect(parseFileName(FILENAME_EXAMPLE).ownerDisplay).toContain("山田");
  });
});
