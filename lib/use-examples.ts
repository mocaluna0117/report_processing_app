"use client";

// 「この書き方を学習」の状態管理 (定期点検・アフターメンテナンスで共通)。
// 覚えるのは (伏せ字済みの入力 → 利用者が最終的に書いた本文) の組で、
// 画面ごとに別の一覧を持つ (入力の形もプロンプトも違うため)。
import { useMemo, useState } from "react";
import {
  type ExampleKind,
  clearStoredExamples,
  deleteStoredExample,
  loadExamples,
  mergeStoredExamples,
  upsertStoredExample,
} from "@/lib/examples-store";
import type { ResultRow } from "@/lib/process";
import { isStorageAvailable } from "@/lib/storage";
import { buildExample, type InquiryExample, upsertExample } from "@/lib/summarize/examples";
import { recordSummary } from "@/lib/summary";

/** 学習ボタンの見せ方 */
export interface LearnState {
  label: string;
  disabled: boolean;
  title: string;
}

export interface Examples<R extends ResultRow> {
  examples: InquiryExample[];
  /** 一覧ダイアログを開いているか */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** 復元時に呼ぶ (usePersistence の restore から) */
  restore: () => Promise<void>;
  learn: (row: R) => Promise<void>;
  learnState: (row: R) => LearnState;
  deleteExample: (id: string) => void;
  importExamples: (incoming: InquiryExample[]) => void;
  clearExamples: () => Promise<void>;
}

export function useExamples<R extends ResultRow>({
  kind,
  inputOf,
  outputLabel,
  storage,
}: {
  kind: ExampleKind;
  /** その行の入力 (伏せ字前でよい。buildExample が伏せ字にする) */
  inputOf: (row: R) => string;
  /** 出力の呼び名 (点検内容 / アフター受付内容)。ボタンの説明に使う */
  outputLabel: string;
  storage: { setStorageError: (value: string | null) => void; refreshUsage: () => void };
}): Examples<R> {
  const [examples, setExamples] = useState<InquiryExample[]>([]);
  const [open, setOpen] = useState(false);
  const exampleById = useMemo(() => new Map(examples.map((e) => [e.id, e])), [examples]);

  /** その行を学習するときの (入力, 出力)。どちらも伏せ字にしてから保存・送信する */
  const exampleOf = (row: R) => buildExample(inputOf(row), recordSummary(row));

  /** 保存に失敗しても作業は止めず、画面内の状態だけは進める */
  const applyExamples = async (
    run: () => Promise<InquiryExample[]>,
    fallback: (list: InquiryExample[]) => InquiryExample[],
  ) => {
    if (!isStorageAvailable()) {
      setExamples(fallback);
      return;
    }
    try {
      setExamples(await run());
      storage.refreshUsage();
    } catch (e) {
      storage.setStorageError(
        `学習した書き方を保存できませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  };

  return {
    examples,
    open,
    setOpen,
    restore: async () => {
      setExamples(await loadExamples(kind));
    },
    learn: async (row) => {
      const { input, output } = exampleOf(row);
      if (!output || !input) return;
      const now = Date.now();
      const example: InquiryExample = {
        id: row.pairId,
        input,
        output,
        createdAt: exampleById.get(row.pairId)?.createdAt ?? now,
        updatedAt: now,
      };
      await applyExamples(
        () => upsertStoredExample(kind, example),
        (list) => upsertExample(list, example),
      );
    },
    learnState: (row) => {
      const { input, output } = exampleOf(row);
      if (!output) {
        return { label: "この書き方を学習", disabled: true, title: `${outputLabel}が空欄です` };
      }
      if (!input) {
        return {
          label: "この書き方を学習",
          disabled: true,
          title: "手本の元になる内容がありません",
        };
      }
      const saved = exampleById.get(row.pairId);
      if (!saved) {
        // 要約をそのまま使っている行も、確認として学習できる
        const edited =
          row.originalSummary !== undefined && row.originalSummary !== recordSummary(row);
        return {
          label: "この書き方を学習",
          disabled: false,
          title: edited
            ? "手直しした書き方を、次回以降の要約の手本にします"
            : `この${outputLabel}の書き方を、次回以降の要約の手本にします (要約のまま)`,
        };
      }
      if (saved.output === output) {
        return { label: "学習済み ✓", disabled: true, title: "この書き方を手本にしています" };
      }
      return { label: "再学習", disabled: false, title: "直したあとの書き方で覚え直します" };
    },
    deleteExample: (id) => {
      void applyExamples(
        () => deleteStoredExample(kind, id),
        (list) => list.filter((e) => e.id !== id),
      );
    },
    importExamples: (incoming) => {
      void applyExamples(
        () => mergeStoredExamples(kind, incoming),
        (list) => list,
      );
    },
    clearExamples: async () => {
      if (!confirm(`学習した書き方 ${examples.length}件 をすべて消去します。よろしいですか？`)) {
        return;
      }
      try {
        await clearStoredExamples(kind);
      } catch {
        // 消せなくても画面からは外す (次の保存で上書きされる)
      }
      setExamples([]);
      setOpen(false);
      storage.refreshUsage();
    },
  };
}
