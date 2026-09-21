import { describe, expect, it } from "vitest";
import { DOC_KINDS, type DocKind, TENMATSU, NATSUIN, SENKETSU } from "@/lib/tenmatsu/kinds";
import { FOLDER_UNSUPPORTED_TEXT } from "@/lib/tenmatsu/local/folder-handle";
import {
  DEPT_READ_FAILED_BLOCK_TEXT,
  DEPT_READING_TEXT,
  type TenmatsuFlowInput,
  canStartRun,
  folderBlockedReason,
  isFreshTenmatsu,
  listEmptyText,
  runBlockedReason,
  tenmatsuFlow,
  tenmatsuStepDefs,
} from "@/lib/tenmatsu/local/flow";

/** 何も始めていない画面（読み込みは終わっている） */
const fresh = (kind: DocKind, over: Partial<TenmatsuFlowInput> = {}): TenmatsuFlowInput => ({
  kind,
  supported: true,
  restored: true,
  hasHandle: false,
  handleName: null,
  connection: "idle",
  connected: false,
  loggedIn: false,
  loginBusy: false,
  departmentCount: null,
  deptLabel: null,
  departmentFailed: false,
  departmentSkipped: false,
  running: false,
  otherRunKind: null,
  itemCount: 0,
  userIdSaved: false,
  ...over,
});

/** 取得できる状態（部門あり・選択済み） */
const ready = (kind: DocKind, over: Partial<TenmatsuFlowInput> = {}): TenmatsuFlowInput =>
  fresh(kind, {
    hasHandle: true,
    handleName: "顛末書",
    connection: "ok",
    connected: true,
    loggedIn: true,
    departmentCount: 2,
    deptLabel: "品質管理部(1900)",
    ...over,
  });

const stateOf = (input: TenmatsuFlowInput, id: string) =>
  tenmatsuFlow(input).steps.find((s) => s.id === id)?.state;

describe.each(DOC_KINDS)("$label の手順", (kind) => {
  it("初回はフォルダーの段がいまここで、次にすることが出る", () => {
    const plan = tenmatsuFlow(fresh(kind));
    expect(plan.currentId).toBe("folder");
    expect(plan.nextHint).toContain("保存先フォルダーを選ぶ");
    expect(plan.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(isFreshTenmatsu(fresh(kind))).toBe(true);
  });

  it("★対応していないブラウザ・読み込み中は、進められない印にする", () => {
    expect(stateOf(fresh(kind, { supported: false }), "folder")).toBe("blocked");
    expect(tenmatsuFlow(fresh(kind, { supported: false })).nextHint).toBe(FOLDER_UNSUPPORTED_TEXT);
    expect(stateOf(fresh(kind, { restored: false }), "folder")).toBe("blocked");
  });

  it("★フォルダーが未接続でも、ログイン済みなら「済んだ」ままにする（ログインは種類で共通）", () => {
    const plan = tenmatsuFlow(fresh(kind, { loggedIn: true, departmentCount: 0 }));
    expect(plan.currentId).toBe("folder");
    expect(plan.steps.find((s) => s.id === "login")?.state).toBe("done");
    expect(plan.steps.find((s) => s.id === "dept")?.state).toBe("done");
  });

  it("つないだだけならログインの段", () => {
    const plan = tenmatsuFlow(fresh(kind, { hasHandle: true, connection: "ok", connected: true, handleName: "顛末書" }));
    expect(plan.currentId).toBe("login");
    expect(plan.nextHint).toContain("ログイン");
    expect(plan.steps[0].note).toBe("顛末書");
  });

  it("部門を読み込んでいない・選んでいないときは、それぞれの案内を出す", () => {
    // ★読み込みは画面が勝手にやるので、「押してください」ではなく「待っていてください」と伝える
    const notLoaded = tenmatsuFlow(ready(kind, { departmentCount: null, deptLabel: null }));
    expect(notLoaded.currentId).toBe("dept");
    expect(notLoaded.nextHint).toBe(DEPT_READING_TEXT);

    const notChosen = tenmatsuFlow(ready(kind, { deptLabel: null }));
    expect(notChosen.currentId).toBe("dept");
    expect(notChosen.nextHint).toContain("部門");
  });

  it("部門の切り替えが無いアカウントは、その段を済んだ扱いにする", () => {
    const plan = tenmatsuFlow(ready(kind, { departmentCount: 0, deptLabel: null }));
    expect(plan.steps.find((s) => s.id === "dept")).toMatchObject({ state: "done", note: "切り替えなし" });
    expect(plan.currentId).toBe("run");
  });

  it("全部そろえば取得の段。取得すると一覧の段へ進む", () => {
    const plan = tenmatsuFlow(ready(kind));
    expect(plan.currentId).toBe("run");
    expect(plan.nextHint).toContain(`「${kind.label}を取得」`);

    const after = tenmatsuFlow(ready(kind, { itemCount: 3 }));
    expect(after.steps.find((s) => s.id === "run")?.state).toBe("done");
    expect(after.currentId).toBe("list");
    expect(after.steps.find((s) => s.id === "list")?.note).toBe("3件");
    expect(isFreshTenmatsu(ready(kind, { itemCount: 3 }))).toBe(false);
  });

  it("取得中は取得の段に「取得中…」を出す", () => {
    const plan = tenmatsuFlow(ready(kind, { running: true }));
    expect(plan.steps.find((s) => s.id === "run")).toMatchObject({ state: "current", note: "取得中…" });
    expect(runBlockedReason(ready(kind, { running: true }))).toBeNull();
  });

  it("★別の種類の取得が動いていたら進められない印にし、どの種類かを出す", () => {
    const other = kind.id === "tenmatsu" ? "senketsu" : "tenmatsu";
    const input = ready(kind, { otherRunKind: other });
    expect(stateOf(input, "run")).toBe("blocked");
    expect(tenmatsuFlow(input).nextHint).toContain(other === "tenmatsu" ? "顛末書" : "専決決裁書");
    expect(runBlockedReason(input)?.text).toContain("終わってから");
  });

  it("段の飛び先は種類ごとに分かれていて、重なっていない", () => {
    const defs = tenmatsuStepDefs(kind);
    expect(defs.every((d) => d.targetId.startsWith(`${kind.id}-`))).toBe(true);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
  });

  it("一覧が空のときの文は、つないでいるかで変える", () => {
    expect(listEmptyText(kind, false)).toContain("保存先フォルダーにつなぐと");
    expect(listEmptyText(kind, true)).toContain("まだ取得した");
  });
});

describe("種類ごとの言い回し", () => {
  it("捺印決裁書の最後の段は「アップロード待ち」「書類を足す」に触れる", () => {
    const last = tenmatsuStepDefs(NATSUIN)[4].description;
    expect(last).toContain("アップロード待ち");
    expect(last).toContain(NATSUIN.text.resolveButton);
  });

  it("顛末書は実行予算、専決決裁書はクラウド格納だけ", () => {
    expect(tenmatsuStepDefs(TENMATSU)[4].description).toContain("実行予算");
    expect(tenmatsuStepDefs(SENKETSU)[4].description).not.toContain("実行予算");
    expect(tenmatsuStepDefs(SENKETSU)[4].description).toContain("クラウド");
  });
});

describe("★押せない理由と、押せるかの判定が食い違わない", () => {
  it("総当たりで確かめる", () => {
    const bool = [true, false];
    let checked = 0;
    for (const supported of bool)
      for (const restored of bool)
        for (const connected of bool)
          for (const loggedIn of bool)
            for (const departmentCount of [null, 0, 2])
              for (const deptLabel of [null, "品質管理部(1900)"])
                for (const running of bool)
                  for (const departmentFailed of bool)
                    for (const departmentSkipped of bool)
                  for (const otherRunKind of [null, "senketsu"] as const) {
                    const input = fresh(TENMATSU, {
                      supported,
                      restored,
                      connected,
                      connection: connected ? "ok" : "idle",
                      hasHandle: connected,
                      loggedIn,
                      departmentCount,
                      deptLabel,
                      departmentFailed,
                      departmentSkipped,
                      running,
                      otherRunKind,
                    });
                    const reason = runBlockedReason(input);
                    expect(
                      reason === null,
                      JSON.stringify({ supported, restored, connected, loggedIn, departmentCount, deptLabel, departmentFailed, departmentSkipped, running, otherRunKind }),
                    ).toBe(
                      canStartRun(input) || running,
                    );
                    // 段は常に1つだけがいまここ（または進められない）
                    const plan = tenmatsuFlow(input);
                    expect(plan.steps.filter((s) => s.state === "current" || s.state === "blocked").length).toBeLessThanOrEqual(1);
                    checked++;
                  }
    expect(checked).toBe(2 * 2 * 2 * 2 * 3 * 2 * 2 * 2 * 2 * 2);
  });

  it("今までの4つの文はそのまま使う（画面の言い回しを変えない）", () => {
    const base = ready(TENMATSU);
    expect(runBlockedReason({ ...base, connected: false })?.text).toBe("保存先フォルダーにつないでください");
    expect(runBlockedReason({ ...base, loggedIn: false })?.text).toBe("楽楽精算にログインしてください");
    expect(runBlockedReason({ ...base, departmentCount: null })?.text).toBe(DEPT_READING_TEXT);
    expect(runBlockedReason({ ...base, otherRunKind: "senketsu" })?.text).toContain("取得が動いています");
  });

  it("★部門を読めなかったときは、読み直しと「指定せず」を促す", () => {
    const input = ready(TENMATSU, { departmentCount: null, deptLabel: null, departmentFailed: true });
    expect(runBlockedReason(input)?.text).toBe(DEPT_READ_FAILED_BLOCK_TEXT);
    expect(canStartRun(input)).toBe(false);
  });

  it("★「部門を指定せず」を選べば取得できる（読めていないときだけ）", () => {
    const skipped = ready(TENMATSU, { departmentCount: null, deptLabel: null, departmentSkipped: true });
    expect(canStartRun(skipped)).toBe(true);
    expect(runBlockedReason(skipped)).toBeNull();
    const plan = tenmatsuFlow(skipped);
    expect(plan.steps.find((s) => s.id === "dept")).toMatchObject({ state: "done", note: "指定せず" });
    expect(plan.currentId).toBe("run");
  });

  it("★選択肢が読めているときは「指定せず」を効かせない（押しても必ず止まるため）", () => {
    const input = ready(TENMATSU, { deptLabel: null, departmentSkipped: true });
    expect(canStartRun(input)).toBe(false);
    expect(runBlockedReason(input)?.text).toBe("部門を選んでください");
  });

  it("★今まで無言だった2つに理由を付ける", () => {
    expect(runBlockedReason(ready(TENMATSU, { deptLabel: null }))?.text).toBe("部門を選んでください");
    expect(runBlockedReason(ready(TENMATSU, { restored: false }))?.text).toContain("読み込んでいます");
  });

  it("理由を直せる欄へ案内する", () => {
    expect(runBlockedReason(ready(TENMATSU, { connected: false }))?.targetId).toBe("tenmatsu-folder");
    expect(runBlockedReason(ready(TENMATSU, { loggedIn: false }))?.targetId).toBe("tenmatsu-rakuraku");
    // 同じ欄の中にあるものは案内しない
    expect(runBlockedReason(ready(TENMATSU, { deptLabel: null }))?.targetId).toBeNull();
  });

  it("フォルダーのボタンの理由", () => {
    expect(folderBlockedReason(ready(TENMATSU))).toBeNull();
    expect(folderBlockedReason(ready(TENMATSU, { running: true }))).toContain("取得中は");
    expect(folderBlockedReason(ready(TENMATSU, { restored: false }))).toContain("読み込んでいます");
  });
});
