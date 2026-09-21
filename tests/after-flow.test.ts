import { describe, expect, it } from "vitest";
import { type AfterFlowInput, afterFlow, intakeBlockedReason, isFreshAfter } from "@/lib/after/flow";

const input = (over: Partial<AfterFlowInput> = {}): AfterFlowInput => ({
  restored: true,
  importing: false,
  customerCount: 0,
  hasSelected: false,
  memoEmpty: true,
  registering: false,
  caseCount: 0,
  ...over,
});

describe("アフターの手順", () => {
  it("初回は顧客データの段", () => {
    const plan = afterFlow(input());
    expect(plan.currentId).toBe("import");
    expect(plan.nextHint).toContain("xlsx / csv");
    expect(plan.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(isFreshAfter(input())).toBe(true);
  });

  it("取り込むとお客様を選ぶ段。件数を添える", () => {
    const plan = afterFlow(input({ customerCount: 1234 }));
    expect(plan.currentId).toBe("select");
    expect(plan.steps[0]).toMatchObject({ state: "done", note: "1,234件" });
    expect(plan.nextHint).toContain("お客様を探す");
  });

  it("取り込み中は補足を出す", () => {
    expect(afterFlow(input({ importing: true })).steps[0].note).toBe("取り込み中");
  });

  it("お客様を選ぶと受付の段。貼り付けると押すよう促す", () => {
    const chosen = afterFlow(input({ customerCount: 10, hasSelected: true }));
    expect(chosen.currentId).toBe("intake");
    expect(chosen.nextHint).toContain("貼り付けて");

    const typed = afterFlow(input({ customerCount: 10, hasSelected: true, memoEmpty: false }));
    expect(typed.nextHint).toContain("「受付を登録」");
  });

  it("登録中は補足を出す", () => {
    const plan = afterFlow(input({ customerCount: 10, hasSelected: true, memoEmpty: false, registering: true }));
    expect(plan.steps.find((s) => s.id === "intake")).toMatchObject({ state: "current", note: "登録中…" });
  });

  it("登録できたら受付一覧の段へ進む", () => {
    const plan = afterFlow(input({ customerCount: 10, hasSelected: true, caseCount: 2 }));
    expect(plan.currentId).toBe("cases");
    expect(plan.steps.find((s) => s.id === "cases")?.note).toBe("2件");
    expect(plan.nextHint).toContain("受付種別");
    expect(isFreshAfter(input({ customerCount: 10, caseCount: 2 }))).toBe(false);
  });

  it("読み込み中は進められない印にする", () => {
    expect(afterFlow(input({ restored: false })).steps[0].state).toBe("blocked");
  });
});

describe("「受付を登録」が押せない理由", () => {
  it("★受付内容が空のときだけ出す（お客様未選択は画面に既に出ている）", () => {
    expect(intakeBlockedReason({ hasCustomer: true, memoEmpty: true, busy: false })).toBe("受付内容を貼り付けてください");
    expect(intakeBlockedReason({ hasCustomer: false, memoEmpty: true, busy: false })).toBeNull();
    expect(intakeBlockedReason({ hasCustomer: true, memoEmpty: false, busy: false })).toBeNull();
    expect(intakeBlockedReason({ hasCustomer: true, memoEmpty: true, busy: true })).toBeNull();
  });
});
