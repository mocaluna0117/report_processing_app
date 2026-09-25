"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ContactDialog } from "@/components/contact-dialog";
import { HelpDialog } from "@/components/help-dialog";
import { SharedFolderDialog } from "@/components/shared-folder-dialog";
import { clearTabForAnotherPerson } from "@/lib/account/sign-out";
import { useSignedIn } from "@/lib/account/use-signed-in";
import { HELP_SECTIONS } from "@/lib/help";
import { getHelpDialogState, openHelp, subscribeHelpDialog } from "@/lib/help-dialog";
import { getNavigationGuard } from "@/lib/navigation-guard";
import { restoreSharedConnection } from "@/lib/shared/connection";
import { SHARED_CHIP_ID, openSharedDialog, subscribeSharedDialog } from "@/lib/shared/dialog";
import { type SharedChipTone, sharedChip, usesSharedFolder } from "@/lib/shared/status";
import { useSharedConnection } from "@/lib/shared/use-shared-folder";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";

/**
 * 共有フォルダーの表示の見た目（4通り）。
 * ★**未接続（alert）はいちばん目立たせる**。ほかのボタンと同じ灰色だと気づかれなかった。
 * ★それを使わない画面（専決決裁書・捺印決裁書）では静かにする（off）。
 * ★楽楽精算の表示は 2026-09-25 に無くした（IDとパスワードはアカウントの画面で登録し、取得のときに自動でログインする）。
 */
const CHIP_CLASS: Record<SharedChipTone, string> = {
  alert: "border border-amber-400 bg-amber-100 font-semibold text-amber-900 shadow-sm hover:bg-amber-200",
  on: "border border-emerald-300 bg-emerald-50 font-medium text-emerald-800 hover:bg-emerald-100",
  off: "border border-slate-300 bg-white font-medium text-slate-600 hover:bg-slate-50",
  unknown: "border border-slate-300 bg-white font-medium text-slate-600 hover:bg-slate-50",
};

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
  /** 誰がログインしているか（表示用。問い合わせのお名前に入れる・仮のパスワードの人にはタブを出さない） */
  const signedIn = useSignedIn();
  // ヘッダーの「使い方」がいま選んだ状態に見えるように（開いていなくても、モーダルの表示と揃える）
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => subscribeHelpDialog((s) => setHelpOpen(s.open)), []);

  // ★ログイン画面に来たら（ログインが切れて移ってきたときも）、このタブの楽楽精算のログインを消す。
  //   消さないと、次にログインした人に前の人の楽楽精算のログインが戻る
  useEffect(() => {
    if (pathname === "/login") clearTabForAnotherPerson();
  }, [pathname]);

  /**
   * 共有フォルダー（Box など）のつながり。Folio 全体で1つ（lib/shared/connection.ts）。
   * ★読み込み直後は許可を尋ねない。許可が生きていればそのままつなぐ（同期するのは使う画面だけ）。
   */
  const connection = useSharedConnection();
  useEffect(() => {
    // ログイン画面では読まない（Folio にログインする前なので）
    if (pathname !== "/login") void restoreSharedConnection();
  }, [pathname]);
  const [sharedOpen, setSharedOpen] = useState(false);
  useEffect(() => subscribeSharedDialog(setSharedOpen), []);
  /** いま見ている画面の使い方を、開いたときの既定タブにする */
  const currentSlug = HELP_SECTIONS.find((s) => s.href === pathname)?.slug ?? null;
  const shared = sharedChip({ ...connection, canPersist: true, usesShared: usesSharedFolder(pathname) });

  // ログイン画面では画面の切り替えを出さない (押しても戻されるだけなので)
  if (pathname === "/login") return null;

  // 処理中の離脱は取り消せないので確認する（タブと「使い方」で共通）
  const guardNavigation = (e: { preventDefault: () => void }) => {
    const guard = getNavigationGuard();
    if (guard && !confirm(guard)) e.preventDefault();
  };


  // ★仮のパスワードで入った人は、パスワードを決めるまでほかの画面を使えないので、タブを出さない
  //   （ログアウトは右上の人の形のアイコンから）
  if (signedIn?.mustChange) return null;

  return (
    <div className="flex flex-wrap items-center gap-3">
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
              onNavigate={guardNavigation}
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
      {/* ★タブではなく右側に置く（画面の種類ではないので MODES には入れない）。
          以前はページへのリンクだったが、モーダルに変えた（2026-09-22） */}
      <button
        type="button"
        onClick={() => openHelp(currentSlug)}
        aria-pressed={helpOpen}
        className={
          helpOpen
            ? "cursor-pointer rounded-md border border-slate-400 bg-white px-2.5 py-1 text-xs font-semibold text-slate-900"
            : "cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        }
      >
        使い方
      </button>
      {/* ★共有フォルダー（データベースの役割）。どの画面からでもつなげるよう、ここに1つだけ置く。
          専決決裁書・捺印決裁書では使わないので、つながっていなくても目立たせない */}
      <button
        id={SHARED_CHIP_ID}
        type="button"
        onClick={openSharedDialog}
        aria-haspopup="dialog"
        aria-pressed={sharedOpen}
        title={shared.title}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${CHIP_CLASS[shared.tone]}`}
      >
        {shared.dot && (
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${shared.tone === "on" ? "bg-emerald-500" : "bg-amber-500"}`}
          />
        )}
        {shared.text}
      </button>
      <HelpDialog />
      <SharedFolderDialog />
      {/* ★問い合わせの小窓は Folio 全体でここに1つ。開くのは右上の人の形のアイコンのメニューと、使い方の小窓のいちばん下
          （2026-09-25 にヘッダーのボタンはメニューへ移した。アカウントを使わない手元ではメニューが出ないので、使い方から開く） */}
      <ContactDialog />
    </div>
  );
}
