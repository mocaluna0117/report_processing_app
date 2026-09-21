/**
 * 画面の上に出す「手順バー」の組み立て。純関数のみ（DOM にも React にも依存しない）。
 *
 * ★初めて使う人が「いまどの段にいるか」「次に何をすればよいか」を見て分かるようにするための道具。
 *   画面ごとの規則は lib/inspection-flow.ts・lib/after/flow.ts・lib/tenmatsu/local/flow.ts に書き、
 *   ここは並べ方だけを受け持つ（規則を vitest で固定できるように、React から切り離してある）。
 */

/** 段の状態。色だけで伝えないよう、画面では文字（完了／いまここ／…）も出す */
export type FlowStepState =
  /** 済んだ */
  | "done"
  /** いまここ（利用者が進められる） */
  | "current"
  /** まだ先 */
  | "todo"
  /** いまここだが、外の条件で進められない（対応外のブラウザ・読み込み中・別の取得が動いている等） */
  | "blocked";

/** 段の定義。文言はここ（各画面の規則の中）に置き、初回の案内と「使い方」ページでも同じものを使う */
export interface FlowStepDef {
  id: string;
  /** 押した先の見出しと同じ語にする（8文字目安） */
  label: string;
  /** 初回の案内と「使い方」に出す1文 */
  description: string;
  /** 押したときに飛ぶ section の id */
  targetId: string;
}

export interface FlowStep extends FlowStepDef {
  state: FlowStepState;
  /** 状態の短い補足（「12件」「取得中…」など）。無ければ null */
  note: string | null;
}

export interface FlowPlan {
  steps: FlowStep[];
  /** current か blocked の段（0か1つ） */
  currentId: string | null;
  /** いまの段が外の条件で進められないか */
  blocked: boolean;
  /** 「次にすること」の1行 */
  nextHint: string;
}

/** 段ごとの見立て。順番に関係のない事実だけを返し、並べ方は resolveFlow に任せる */
export type StepEval =
  | { kind: "done"; note?: string }
  /** いま進められる */
  | { kind: "ready"; hint: string; note?: string }
  /** 外の条件で進められない */
  | { kind: "blocked"; hint: string; note?: string };

/**
 * 段の状態を決める。
 *
 * ★**最初の「済んでいない段」だけ**が current（その見立てが blocked なら blocked）になり、その hint が
 *   「次にすること」になる。あとの済んでいない段は todo。
 * ★**済んだ段は、current より後ろにあっても done のまま**にする。顛末書系はログインが3つのタブで共通なので、
 *   「フォルダーは未接続だがログインは済んでいる」が普通に起きる。ここを「順番どおりにしか進まない」形にすると、
 *   済んだことを「まだ」と表示してしまう。
 */
export function resolveFlow(
  defs: readonly FlowStepDef[],
  evals: readonly StepEval[],
  fallbackHint: string,
): FlowPlan {
  const firstUnfinished = evals.findIndex((e) => e.kind !== "done");
  const steps: FlowStep[] = defs.map((def, i) => {
    const step = evals[i];
    if (!step || step.kind === "done") {
      return { ...def, state: "done", note: step?.note ?? null };
    }
    if (i === firstUnfinished) {
      return { ...def, state: step.kind === "blocked" ? "blocked" : "current", note: step.note ?? null };
    }
    return { ...def, state: "todo", note: step.note ?? null };
  });

  const current = firstUnfinished >= 0 ? steps[firstUnfinished] : null;
  const currentEval = firstUnfinished >= 0 ? evals[firstUnfinished] : null;
  return {
    steps,
    currentId: current?.id ?? null,
    blocked: current?.state === "blocked",
    nextHint: currentEval && currentEval.kind !== "done" ? currentEval.hint : fallbackHint,
  };
}
