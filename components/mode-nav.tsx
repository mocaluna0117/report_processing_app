"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SIGNED_IN_COOKIE } from "@/lib/auth";
import { getNavigationGuard } from "@/lib/navigation-guard";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";

/**
 * 画面 (処理の種類)。扱うデータが別なのでURLも分ける。
 * 顛末書と専決決裁書は同じ作りなので、種類の設定から並べる。
 */
export const MODES: readonly { href: string; label: string }[] = [
  { href: "/", label: "定期点検" },
  { href: "/after", label: "アフターメンテナンス" },
  ...DOC_KINDS.map((k) => ({ href: k.route, label: k.menuLabel })),
];

export function ModeNav() {
  const pathname = usePathname();
  /**
   * ログイン中か (パスワード保護を使っていない環境では出さない)。
   * 判定に使う印は httpOnly ではないクッキーで、認証そのものは proxy.ts が見る。
   * 読むのはマウント後 (サーバー側の描画と食い違わないように)。
   */
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    setSignedIn(document.cookie.split("; ").some((c) => c === `${SIGNED_IN_COOKIE}=1`));
  }, []);

  // ログイン画面では画面の切り替えを出さない (押しても戻されるだけなので)
  if (pathname === "/login") return null;

  return (
    <div className="flex items-center gap-3">
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
      {signedIn && (
        <form method="post" action="/api/logout">
          <button
            type="submit"
            title="このブラウザのログインを解除します (共有の端末では作業後に押してください)"
            className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            ログアウト
          </button>
        </form>
      )}
    </div>
  );
}
