/**
 * アフターメンテナンス受付の画面の「手順」と「押せない理由」。純関数のみ。
 *
 * ★顧客データを取り込むまで、お客様を探す欄も受付内容の欄も画面に出ない作りなので、
 *   初めての人には次に何が出てくるのかが分からなかった。段を先に見せる。
 */
import { type FlowPlan, type FlowStepDef, type StepEval, resolveFlow } from "@/lib/flow-steps";

export const AFTER_STEPS: readonly FlowStepDef[] = [
  {
    id: "import",
    label: "顧客データ",
    description:
      "顧客情報の xlsx / csv をドロップします。助っ人クラウド・点検保守台帳のどちらの形式かは自動で判定します。",
    targetId: "after-import",
  },
  {
    id: "select",
    label: "お客様を選ぶ",
    description: "氏名・カナ・PJ・物件名・住所・電話番号で探して、お客様を選びます。",
    targetId: "after-search",
  },
  {
    id: "intake",
    label: "受付を登録",
    description:
      "コールセンターの受付内容を貼り付けて「受付を登録」を押すと、不具合の事象に要約されます。",
    targetId: "after-intake",
  },
  {
    id: "cases",
    label: "受付一覧",
    description:
      "受付一覧で受付種別を選び、「Excel用にコピー」で貼り付けます。メール文・完了報告書も行から作れます。",
    targetId: "after-cases",
  },
];

export interface AfterFlowInput {
  restored: boolean;
  importing: boolean;
  customerCount: number;
  hasSelected: boolean;
  /** 受付内容が空か */
  memoEmpty: boolean;
  registering: boolean;
  caseCount: number;
}

/**
 * 「受付を登録」が押せない理由。
 * ★お客様が未選択のときは画面に既に「先にお客様を選んでください」が出ているので、ここでは出さない
 *   （同じことを2か所に書かない）。
 */
export function intakeBlockedReason(input: { hasCustomer: boolean; memoEmpty: boolean; busy: boolean }): string | null {
  if (input.busy || !input.hasCustomer) return null;
  if (input.memoEmpty) return "受付内容を貼り付けてください";
  return null;
}

/** 何も始めていない画面か（初回の案内を出すかどうか） */
export function isFreshAfter(input: AfterFlowInput): boolean {
  return input.restored && input.customerCount === 0 && input.caseCount === 0;
}

export function afterFlow(input: AfterFlowInput): FlowPlan {
  const importStep: StepEval = !input.restored
    ? { kind: "blocked", hint: "前回の内容を読み込んでいます。少しお待ちください" }
    : input.importing
      ? { kind: "ready", hint: "顧客データを取り込んでいます…", note: "取り込み中" }
      : input.customerCount > 0
        ? { kind: "done", note: `${input.customerCount.toLocaleString()}件` }
        : {
            kind: "ready",
            hint: "顧客情報の xlsx / csv を「顧客データ」の枠にドロップしてください (助っ人クラウド・点検保守台帳のどちらでも構いません)",
          };

  const select: StepEval =
    input.customerCount === 0
      ? { kind: "ready", hint: "先に顧客データを取り込んでください" }
      : input.hasSelected
        ? { kind: "done" }
        : {
            kind: "ready",
            hint: "「お客様を探す」に氏名・PJコード・電話番号などを入れて、一覧からお客様を選んでください",
          };

  const intake: StepEval = !input.hasSelected
    ? { kind: "ready", hint: "先にお客様を選んでください" }
    : input.registering
      ? { kind: "ready", hint: "要約が終わるまでお待ちください", note: "登録中…" }
      : !input.memoEmpty
        ? { kind: "ready", hint: "「受付を登録」を押してください (Ctrl+Enter でも登録できます)" }
        : input.caseCount > 0
          ? { kind: "done" }
          : {
              kind: "ready",
              hint: "「受付内容」にコールセンターの記録を貼り付けて「受付を登録」を押してください",
            };

  const cases: StepEval = {
    kind: "ready",
    hint:
      input.caseCount > 0
        ? "受付一覧で受付種別を選び、「Excel用にコピー」で貼り付けます。行の「メール文」「完了報告書」で文書も作れます。続けて登録するときは、お客様を選んで受付内容を貼り付けてください"
        : AFTER_STEPS[3].description,
    ...(input.caseCount > 0 ? { note: `${input.caseCount}件` } : {}),
  };

  return resolveFlow(AFTER_STEPS, [importStep, select, intake, cases], AFTER_STEPS[3].description);
}
