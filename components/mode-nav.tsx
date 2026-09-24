"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ContactDialog } from "@/components/contact-dialog";
import { HelpDialog } from "@/components/help-dialog";
import { RakurakuLoginDialog } from "@/components/rakuraku-login-dialog";
import { SharedFolderDialog } from "@/components/shared-folder-dialog";
import { clearTabForAnotherPerson } from "@/lib/account/sign-out";
import { useSignedIn } from "@/lib/account/use-signed-in";
import { CONTACT_BUTTON_ID, openContact, subscribeContact } from "@/lib/contact/dialog";
import { HELP_SECTIONS } from "@/lib/help";
import { getHelpDialogState, openHelp, subscribeHelpDialog } from "@/lib/help-dialog";
import { getNavigationGuard } from "@/lib/navigation-guard";
import type { ChipTone } from "@/lib/rakuraku-login-dialog";
import {
  RAKURAKU_CHIP_ID,
  openLoginDialog,
  rakurakuChip,
  subscribeLoginDialog,
} from "@/lib/rakuraku-login-dialog";
import { restoreSharedConnection } from "@/lib/shared/connection";
import { SHARED_CHIP_ID, openSharedDialog, subscribeSharedDialog } from "@/lib/shared/dialog";
import { sharedChip, usesSharedFolder } from "@/lib/shared/status";
import { useSharedConnection } from "@/lib/shared/use-shared-folder";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";
import {
  getLoginUserId,
  getSessionToken,
  restoreLogin,
  subscribeLogin,
} from "@/lib/tenmatsu/local/session";

/**
 * 楽楽精算・共有フォルダーの表示の見た目（同じ4通り）。
 * ★**未ログイン・未接続（alert）はいちばん目立たせる**。ほかのボタンと同じ灰色だと気づかれなかった。
 * ★それを使わない画面では静かにする（off）。楽楽精算は定期点検・アフター、
 *   共有フォルダーは専決決裁書・捺印決裁書で使わない。
 */
const CHIP_CLASS: Record<ChipTone, string> = {
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

  /**
   * 楽楽精算のログイン状態。
   * ★初期値は sessionStorage を読まない（サーバーで描いた中身と食い違わせない）。
   *   読むのはマウント後。known が false のあいだは「楽楽精算」とだけ出す。
   */
  const [rakuraku, setRakuraku] = useState({ known: false, loggedIn: false, userId: null as string | null });
  useEffect(() => {
    const sync = () =>
      setRakuraku({ known: true, loggedIn: getSessionToken() !== null, userId: getLoginUserId() });
    const stop = subscribeLogin(sync);
    // ★restoreLogin は一度しか戻さない。先にマウントしたこちらが使い切るので、必ず後で読み直す
    restoreLogin();
    sync();
    return stop;
  }, []);
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => subscribeLoginDialog((s) => setLoginOpen(s.open)), []);

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
  const [contactOpen, setContactOpen] = useState(false);
  useEffect(() => subscribeContact(setContactOpen), []);
  /** いま見ている画面の使い方を、開いたときの既定タブにする */
  const currentSlug = HELP_SECTIONS.find((s) => s.href === pathname)?.slug ?? null;
  /** いま見ているのが顛末書系ならその種類（楽楽精算を使う画面か）。ほかは null */
  const currentKind = DOC_KINDS.find((k) => k.route === pathname)?.id ?? null;
  const chip = rakurakuChip({ ...rakuraku, onDocPage: currentKind !== null });
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
  if (signedIn && !signedIn.legacy && signedIn.mustChange) return null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
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
      {/* ★不具合・要望を開発者へ送る（Folio 全体で1つ）。開いた画面を最初から選んでおく */}
      <button
        id={CONTACT_BUTTON_ID}
        type="button"
        onClick={() => openContact({ page: pathname, name: signedIn && !signedIn.legacy ? signedIn.name : null })}
        aria-haspopup="dialog"
        aria-pressed={contactOpen}
        className={
          contactOpen
            ? "cursor-pointer rounded-md border border-slate-400 bg-white px-2.5 py-1 text-xs font-semibold text-slate-900"
            : "cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        }
      >
        問い合わせ
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
      {/* ★楽楽精算のログイン（Folio 自体のログインとは別物）。どの画面からでも開けるよう
          ここに1つだけ置く。定期点検・アフターでは自分から開かない（楽楽精算を使わないため） */}
      <button
        id={RAKURAKU_CHIP_ID}
        type="button"
        onClick={() => openLoginDialog("manual", currentKind)}
        aria-haspopup="dialog"
        aria-pressed={loginOpen}
        title={chip.title}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${CHIP_CLASS[chip.tone]}`}
      >
        {chip.dot && (
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${chip.tone === "on" ? "bg-emerald-500" : "bg-amber-500"}`}
          />
        )}
        {chip.text}
      </button>
      <HelpDialog />
      <RakurakuLoginDialog />
      <SharedFolderDialog />
      <ContactDialog />
    </div>
  );
}
