/**
 * 定期点検の画面の「手順」と「押せない理由」。純関数のみ。
 *
 * ★この画面は、前の段を済ませるまで次の欄が画面に出ない作りなので、初めての人には
 *   「次に何が出てくるか」が分からなかった。段を先に見せ、押せない理由も文字で出す。
 */
import { type FlowPlan, type FlowStepDef, type StepEval, resolveFlow } from "@/lib/flow-steps";
import type { SelectionCounts } from "@/lib/run-plan";

/** ドロップ欄に常に出すファイル名の例。★lib/pairing.ts が読める形であることをテストで固定する */
export const FILENAME_EXAMPLE = "20260722 【写真報告書】山田　太郎様邸.PDF";

export const INSPECTION_STEPS: readonly FlowStepDef[] = [
  {
    id: "drop",
    label: "PDFをドロップ",
    description: `写真報告書と点検報告書のPDFをまとめてドロップします。ファイル名の日付と施主名から自動で組にします (例: ${FILENAME_EXAMPLE})。`,
    targetId: "inspection-drop",
  },
  {
    id: "pairs",
    label: "ペアを確かめる",
    description:
      "ペアリング結果で組み合わせを確かめます。違うときはプルダウンで直せます。処理するペアにはチェックを入れます (未処理は最初からチェックされています)。",
    targetId: "inspection-pairs",
  },
  {
    id: "run",
    label: "処理する",
    description: "「選択した◯件を処理」を押すと、結合PDFの作成とExcel転記用の抽出を行います。",
    targetId: "inspection-pairs",
  },
  {
    id: "results",
    label: "結果を使う",
    description:
      "抽出結果の「Excel用にコピー」で貼り付け、行の「メール文」「完了報告書」で文書を作ります。",
    targetId: "inspection-results",
  },
];

export interface InspectionFlowInput {
  restored: boolean;
  processing: boolean;
  /** 取り込んだファイルの数 */
  fileCount: number;
  /** 種別を判定できなかったファイルの数 */
  unclassifiedCount: number;
  counts: SelectionCounts;
  /** ファイル名が完全には一致していない組の数 */
  needsReviewCount: number;
  /** 抽出できた行の数 */
  okRowCount: number;
}

/** 処理ボタンが押せない理由。★今まで吹き出しにしか出ていなかった */
export function inspectionRunBlockedReason(input: InspectionFlowInput): string | null {
  if (input.processing) return null; // ボタン自身が進み具合を出している
  if (!input.restored) return "前回の内容を読み込んでいます…";
  if (input.counts.runnable === 0) return "写真報告書が無いペアは処理できません。写真報告書のPDFを足してください";
  if (input.counts.selected === 0) return "ペアリング結果でチェックを入れてください";
  return null;
}

/** 何も始めていない画面か（初回の案内を出すかどうか） */
export function isFreshInspection(input: InspectionFlowInput): boolean {
  return input.restored && input.fileCount === 0 && input.counts.total === 0 && input.okRowCount === 0;
}

export function inspectionFlow(input: InspectionFlowInput): FlowPlan {
  const { counts } = input;
  /** 未処理が無く、処理済みがある＝この画面でやることは済んでいる */
  const allProcessed = counts.unprocessed === 0 && counts.processed > 0;

  const drop: StepEval = !input.restored
    ? { kind: "blocked", hint: "前回の内容を読み込んでいます。少しお待ちください" }
    : counts.total > 0
      ? { kind: "done", note: `${input.fileCount}ファイル` }
      : input.unclassifiedCount > 0
        ? {
            kind: "ready",
            hint: `ファイル名に【写真報告書】か【点検報告書】が入っていないので種別が分かりません。名前を確かめて入れ直してください (例: ${FILENAME_EXAMPLE})`,
          }
        : { kind: "ready", hint: "写真報告書と点検報告書のPDFをまとめて、上の枠にドロップしてください" };

  const pairs: StepEval =
    counts.total === 0
      ? { kind: "ready", hint: "先にPDFをドロップしてください" }
      : counts.runnable === 0
        ? { kind: "blocked", hint: "写真報告書が無いので処理できません。写真報告書のPDFを足してください" }
        : counts.selected > 0 || allProcessed
          ? {
              kind: "done",
              ...(input.needsReviewCount > 0 ? { note: `要確認 ${input.needsReviewCount}組` } : {}),
            }
          : {
              kind: "ready",
              hint: "処理するペアの左端にチェックを入れてください (未処理のペアは最初からチェックされています)",
            };

  const run: StepEval = input.processing
    ? { kind: "ready", hint: "処理が終わるまでお待ちください", note: "処理中…" }
    : !input.restored
      ? { kind: "blocked", hint: "前回の内容を読み込んでいます。少しお待ちください" }
      : counts.selected > 0
        ? {
            kind: "ready",
            hint:
              `「選択した${counts.selected}件を処理」を押してください` +
              (input.needsReviewCount > 0 ? "。要確認の組は、プルダウンで相手を確かめてから押してください" : ""),
          }
        : allProcessed
          ? { kind: "done" }
          : { kind: "ready", hint: "先にペアにチェックを入れてください" };

  const results: StepEval = {
    kind: "ready",
    hint: INSPECTION_STEPS[3].description,
    ...(input.okRowCount > 0 ? { note: `${input.okRowCount}件` } : {}),
  };

  return resolveFlow(INSPECTION_STEPS, [drop, pairs, run, results], INSPECTION_STEPS[3].description);
}
