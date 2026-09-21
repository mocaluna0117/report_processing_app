import type { ReactNode } from "react";

/**
 * 説明の「続き」をしまう折りたたみ。
 *
 * ★画面に出すのは要点1文だけにして、細かい話はここへ入れる（利用者の決定 2026-09-21）。
 *   長い説明をそのまま並べると読み飛ばされ、結局どこにも伝わらない。
 * ★用途は「1文の続き」だけ。機能ごと畳んである既存の <details>（画面の下見・取得の記録・
 *   游ゴシックの説明）はそれぞれ役割が違うので、これに置き換えない。
 * ★安全・個人情報に関わる説明は、畳んでも必ずこの中に残す（消さない）。
 */
export function MoreDetails({
  summary = "くわしく",
  size = "sm",
  className = "",
  children,
}: {
  summary?: string;
  /** xs: 小さい補足の中に置くとき / sm: 本文の中に置くとき */
  size?: "sm" | "xs";
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={`mt-1 ${size === "xs" ? "text-xs text-slate-500" : "text-sm text-slate-600"} ${className}`}>
      {/* 点線の下線で「押すと続きが出る」ことを見せる（三角の印はブラウザ既定のまま） */}
      <summary className="cursor-pointer select-none underline decoration-dotted underline-offset-2 hover:text-slate-700">
        {summary}
      </summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}
