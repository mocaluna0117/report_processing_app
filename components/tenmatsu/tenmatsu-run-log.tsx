"use client";

// 取得中にPCのコンソールへ出ている行を、そのままの形で見せる欄。
// PCの黒い画面を見に行かなくても、伝票ごとの進み具合 (本体・添付・結合・保存先) が分かる。
//
// ★このブラウザのメモリの中にだけある。folio のサーバー (Vercel) へは送らず、
//   IndexedDB にも保存しない。次の実行を始めるか再読み込みすれば消える。
import { useEffect, useRef } from "react";
import type { RunLogLine } from "@/lib/tenmatsu/client";
import { runLogTone } from "@/lib/tenmatsu/run-log";

/** 一番下から何px以内なら「下を見ている」とみなすか (行の高さより十分小さい値) */
const STICK_SLACK_PX = 4;

const TONE_CLASS = {
  ok: "text-emerald-700",
  warn: "text-amber-700",
  plain: "text-slate-600",
} as const;

export function TenmatsuRunLog({ lines }: { lines: readonly RunLogLine[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  // 一番下を見ているときだけ新しい行へ追従する。
  // 常に追従すると、上へスクロールして読んでいる最中に引き戻されて読めない
  const stickRef = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [lines.length]);

  return (
    <details className="mt-3 text-xs text-slate-500" open>
      <summary className="cursor-pointer select-none">取得の記録 ({lines.length}行)</summary>
      <div
        ref={boxRef}
        onScroll={(e) => {
          const box = e.currentTarget;
          stickRef.current =
            box.scrollHeight - box.scrollTop - box.clientHeight < STICK_SLACK_PX;
        }}
        className="mt-1 max-h-64 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap"
      >
        {lines.map((line) => (
          <div key={line.seq} className={TONE_CLASS[runLogTone(line.text)]}>
            {/* 空行は伝票ごとの区切りなので、高さを保ったまま残す */}
            {line.text || " "}
          </div>
        ))}
      </div>
      <p className="mt-1">
        PCの黒い画面に出ている行と同じものです。このブラウザの中にだけあり、保存はしません
        (次の取得を始めるか、画面を再読み込みすると消えます)。
      </p>
    </details>
  );
}
