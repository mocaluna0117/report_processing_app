"use client";

/**
 * 右上（「Folio」の見出しと同じ行の右端）の、人の形のアイコンと名前。押すと小さなメニューが開く。
 * - 名前とログインID
 * - アカウント（パスワードを変える・楽楽精算のIDとパスワードの登録。管理者はアカウントの管理も）
 * - 問い合わせ（2026-09-25 にヘッダーの段から移した。小窓そのものは components/mode-nav.tsx に1つだけ置いてある）
 * - Folio からログアウト（★このタブの楽楽精算のログインも一緒に忘れる）
 * ログインしていない画面・ログイン画面では出さない。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FOLIO_LOGOUT_LABEL, FOLIO_LOGOUT_TITLE, accountMenuView } from "@/lib/account/menu";
import { clearTabForAnotherPerson } from "@/lib/account/sign-out";
import { useSignedIn } from "@/lib/account/use-signed-in";
import { openContact } from "@/lib/contact/dialog";
import { getNavigationGuard } from "@/lib/navigation-guard";

/** よくある人の形（頭と肩） */
function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="currentColor">
      <path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.14 0-7.5 2.46-7.5 5.5 0 .83.67 1.5 1.5 1.5h12c.83 0 1.5-.67 1.5-1.5 0-3.04-3.36-5.5-7.5-5.5Z" />
    </svg>
  );
}

/** ★項目の文字は折り返さない（「アカウント（パスワード・楽楽精算・管理）」が2行になっていた。メニューの幅を文字に合わせる） */
const ITEM_CLASS =
  "block w-full cursor-pointer whitespace-nowrap rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100";

export function AccountMenu() {
  const pathname = usePathname();
  const signedIn = useSignedIn();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 画面を移ったら閉じる
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname が変わったときだけ閉じる
  useEffect(() => setOpen(false), [pathname]);

  // 外を押す・Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (pathname === "/login" || !signedIn) return null;
  const view = accountMenuView(signedIn);

  // 処理中の離脱は取り消せないので確かめる（タブと同じ）
  const guard = (e: { preventDefault: () => void }) => {
    const message = getNavigationGuard();
    if (message && !confirm(message)) e.preventDefault();
  };

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        id="account-menu-button"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={view.label}
        title={view.label}
        className={`flex h-9 max-w-44 cursor-pointer items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 shadow-sm ${
          open || pathname === "/account"
            ? "border-slate-400 bg-slate-100 text-slate-800"
            : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-800"
        }`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <UserIcon />
        </span>
        {/* ★名前はいつも出す（押したり乗せたりしなくても、誰でログインしているか分かるように） */}
        <span className="truncate text-sm font-medium">{view.short}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="アカウント"
          className="absolute right-0 top-full z-40 mt-2 w-max min-w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-semibold text-slate-900">{view.heading}</p>
            <p className="mt-0.5 text-xs text-slate-500">{view.sub}</p>
          </div>
          {view.accountLink && (
            <Link href="/account" role="menuitem" onNavigate={guard} className={ITEM_CLASS}>
              {view.accountLink}
            </Link>
          )}
          {view.contact && (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              onClick={() => {
                // ★先にメニューを閉じる（メニューの外を押したら閉じる仕掛けと、小窓の仕掛けを同時に動かさない）
                setOpen(false);
                // 開いた画面を最初から選び、お名前に表示名を入れる（下書きが空のときだけ。lib/contact/dialog.ts）
                openContact({ page: pathname, name: signedIn.name });
              }}
              className={ITEM_CLASS}
            >
              {view.contact}
            </button>
          )}
          <div aria-hidden className="my-1 h-px bg-slate-200" />
          <form
            method="post"
            action="/api/logout"
            onSubmit={(e) => {
              guard(e);
              if (e.defaultPrevented) return;
              // ★このタブの楽楽精算のログインも忘れる（次にこの端末を使う人に残さない）
              clearTabForAnotherPerson();
            }}
          >
            <button type="submit" role="menuitem" title={FOLIO_LOGOUT_TITLE} className={ITEM_CLASS}>
              {FOLIO_LOGOUT_LABEL}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
