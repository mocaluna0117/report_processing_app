import { describe, expect, it } from "vitest";
import { type FlowStepDef, type StepEval, resolveFlow } from "@/lib/flow-steps";

const defs: FlowStepDef[] = [
  { id: "a", label: "あ", description: "あの説明", targetId: "t-a" },
  { id: "b", label: "い", description: "いの説明", targetId: "t-b" },
  { id: "c", label: "う", description: "うの説明", targetId: "t-c" },
];
const done = (note?: string): StepEval => ({ kind: "done", ...(note ? { note } : {}) });
const ready = (hint: string, note?: string): StepEval => ({ kind: "ready", hint, ...(note ? { note } : {}) });
const blocked = (hint: string): StepEval => ({ kind: "blocked", hint });

const states = (evals: StepEval[]) => resolveFlow(defs, evals, "終わりました").steps.map((s) => s.state);

describe("resolveFlow", () => {
  it("最初の済んでいない段が「いまここ」、あとは「まだ」", () => {
    const plan = resolveFlow(defs, [done(), ready("いを進めてください"), ready("うを進めてください")], "終わりました");
    expect(plan.steps.map((s) => s.state)).toEqual(["done", "current", "todo"]);
    expect(plan.currentId).toBe("b");
    expect(plan.nextHint).toBe("いを進めてください");
    expect(plan.blocked).toBe(false);
  });

  it("★進められない段は blocked にして、その理由を次にすることに出す", () => {
    const plan = resolveFlow(defs, [blocked("読み込んでいます"), ready("い"), ready("う")], "終わりました");
    expect(plan.steps[0].state).toBe("blocked");
    expect(plan.blocked).toBe(true);
    expect(plan.nextHint).toBe("読み込んでいます");
  });

  it("★済んだ段は、いまここより後ろにあっても done のまま（ログインは種類をまたいで共通）", () => {
    expect(states([ready("あ"), done(), ready("う")])).toEqual(["current", "done", "todo"]);
  });

  it("いまここは多くても1つ", () => {
    for (const evals of [
      [ready("a"), ready("b"), ready("c")],
      [done(), done(), ready("c")],
      [done(), done(), done()],
    ] as StepEval[][]) {
      const plan = resolveFlow(defs, evals, "終わりました");
      expect(plan.steps.filter((s) => s.state === "current" || s.state === "blocked").length).toBeLessThanOrEqual(1);
    }
  });

  it("全部済んだら、次にすることは渡した文", () => {
    const plan = resolveFlow(defs, [done(), done(), done()], "終わりました");
    expect(plan.currentId).toBeNull();
    expect(plan.nextHint).toBe("終わりました");
    expect(plan.blocked).toBe(false);
  });

  it("補足は状態に関わらず残す（件数などを出すため）", () => {
    const plan = resolveFlow(defs, [done("12件"), ready("い", "読み込み中"), ready("う")], "終わりました");
    expect(plan.steps.map((s) => s.note)).toEqual(["12件", "読み込み中", null]);
  });

  it("定義より見立てが少なければ、足りない分は済んだ扱いにする（組み立ての取り違えで落とさない）", () => {
    expect(states([ready("あ")])).toEqual(["current", "done", "done"]);
  });
});
