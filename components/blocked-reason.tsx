"use client";

// 押せないボタンの理由を、**見える文字**で出す。
//
// ★今までは吹き出し (title) だけだったので、マウスを乗せない人には理由が分からなかった。
//   吹き出しはそのまま残し、ここで文字も出す。
// ★枠は付けない。枠付きの琥珀色 (WARN_CLASS) は「警告」で使っているので、案内と見分けられるようにする。
import { scrollToSection } from "@/components/flow-steps";

export function BlockedReason({
  reason,
  targetId,
  targetLabel,
  className = "",
  onTarget,
}: {
  reason: string | null;
  /** その理由を直せる欄。渡すと「→ …」のボタンを出す */
  targetId?: string | null;
  targetLabel?: string | null;
  className?: string;
  /** 欄へ動かすほかにすることがあれば（モーダルで行う手順のために足した） */
  onTarget?: (targetId: string) => void;
}) {
  if (!reason) return null;
  return (
    <p role="note" className={`flex flex-wrap items-center gap-1 text-xs text-amber-800 ${className}`}>
      <span aria-hidden>!</span>
      {reason}
      {targetId && targetLabel && (
        <button
          type="button"
          onClick={() => {
            scrollToSection(targetId);
            onTarget?.(targetId);
          }}
          className="cursor-pointer underline hover:text-amber-950"
        >
          → {targetLabel}
        </button>
      )}
    </p>
  );
}
