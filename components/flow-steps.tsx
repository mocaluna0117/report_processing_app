"use client";

// 画面の上に出す「手順バー」。いまどの段にいるか・次に何をすればよいかを見せる。
//
// ★どの段かを決める規則は lib/flow-steps.ts と画面ごとの lib/*flow*.ts にあり、ここは描くだけ。
//   （React のテスト基盤が無いので、間違えると困る判断はすべて純関数側に置いてある）
// ★状態は色だけで伝えない。読み上げ用に「完了」「いまここ」などの語も入れる。
import type { ReactNode } from "react";
import type { FlowPlan, FlowStepState } from "@/lib/flow-steps";
import { openHelp } from "@/lib/help-dialog";

/** 段の印と、読み上げ用の状態の語 */
const STATE_STYLE: Record<FlowStepState, { badge: string; word: string; label: string }> = {
  done: { badge: "bg-emerald-100 text-emerald-800", word: "完了", label: "font-medium text-slate-800" },
  current: { badge: "bg-blue-600 text-white", word: "いまここ", label: "font-semibold text-slate-900" },
  blocked: { badge: "bg-amber-100 text-amber-900", word: "進めません", label: "font-semibold text-slate-900" },
  todo: { badge: "bg-slate-100 text-slate-500", word: "まだ", label: "text-slate-500" },
};

/**
 * その id の欄へ動かす。
 * ★まだ画面に出ていない欄（処理する前のペアリング結果など）は何もしない。
 */
export function scrollToSection(id: string): void {
  const el = typeof document === "undefined" ? null : document.getElementById(id);
  if (!el) return;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  // キーボード・読み上げの人にも「そこへ移った」ことを伝える（画面は動かさない）
  el.focus({ preventScroll: true });
}

export function FlowSteps({
  plan,
  ariaLabel,
  expanded,
  title = "はじめて使う方へ",
  intro,
  helpSlug,
  onStepClick,
}: {
  plan: FlowPlan;
  ariaLabel: string;
  /** 何も始めていないときだけ、各段の説明も出す */
  expanded: boolean;
  /**
   * 段を押したときに、欄へ動かすほかにすることがあれば。
   * （前は楽楽精算のログインの小窓を開くために使っていた。2026-09-25 に小窓を無くしたので、いまは使っていない）
   */
  onStepClick?: (step: FlowPlan["steps"][number]) => void;
  title?: string;
  intro?: ReactNode;
  /** 「使い方を見る」で開くモーダルの、最初に選んでおく画面（lib/help.ts の HelpSection.slug） */
  helpSlug: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className={`mt-4 rounded-lg border bg-white px-4 py-3 ${expanded ? "border-blue-200" : "border-slate-200"}`}
    >
      {/* ★段の並びとヒントの行は、初回の案内が消えても動かないよう常に同じ形で出す */}
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {plan.steps.map((step, i) => {
          const style = STATE_STYLE[step.state];
          return (
            <li key={step.id} aria-current={step.state === "current" || step.state === "blocked" ? "step" : undefined}>
              <button
                type="button"
                onClick={() => {
                  scrollToSection(step.targetId);
                  onStepClick?.(step);
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-slate-50"
              >
                <span
                  aria-hidden
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${style.badge}`}
                >
                  {step.state === "done" ? "✓" : step.state === "blocked" ? "!" : i + 1}
                </span>
                <span className="sr-only">
                  {style.word}:{" "}
                </span>
                <span className={`whitespace-nowrap ${style.label}`}>{step.label}</span>
                {step.note && <span className="hidden text-xs text-slate-500 sm:inline">{step.note}</span>}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className={`text-xs ${plan.blocked ? "text-amber-800" : "text-slate-700"}`}>
          <span className="font-medium">次にすること: </span>
          {plan.blocked && <span aria-hidden>! </span>}
          {plan.nextHint}
        </p>
        {/* ★以前はページへのリンクだったが、モーダルに変えた（2026-09-22） */}
        <button
          type="button"
          onClick={() => openHelp(helpSlug)}
          className="cursor-pointer text-xs text-slate-500 underline hover:text-slate-700"
        >
          使い方を見る
        </button>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {intro && <p className="mt-1 text-sm text-slate-600">{intro}</p>}
          <ol className="mt-2 space-y-1 text-sm text-slate-700">
            {plan.steps.map((step, i) => (
              <li key={step.id}>
                <span className="font-medium">
                  {i + 1}. {step.label}
                </span>
                {" — "}
                {step.description}
              </li>
            ))}
          </ol>
        </div>
      )}
    </nav>
  );
}
