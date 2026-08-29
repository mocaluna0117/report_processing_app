"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getNavigationGuard } from "@/lib/navigation-guard";

/** 画面 (処理の種類)。定期点検とアフターメンテナンスで扱うデータが別なのでURLも分ける */
export const MODES = [
  { href: "/", label: "定期点検" },
  { href: "/after", label: "アフターメンテナンス" },
] as const;

export function ModeNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="処理の種類"
      className="inline-flex rounded-lg bg-slate-200 p-1 text-sm shadow-inner"
    >
      {MODES.map((mode) => {
        const active = pathname === mode.href;
        return (
          <Link
            key={mode.href}
            href={mode.href}
            aria-current={active ? "page" : undefined}
            onNavigate={(e) => {
              // 処理中の離脱は取り消せないので確認する
              const guard = getNavigationGuard();
              if (guard && !confirm(guard)) e.preventDefault();
            }}
            className={
              active
                ? "rounded-md bg-white px-3 py-1.5 font-semibold text-slate-900 shadow-sm"
                : "rounded-md px-3 py-1.5 font-medium text-slate-600 hover:text-slate-900"
            }
          >
            {mode.label}
          </Link>
        );
      })}
    </nav>
  );
}
