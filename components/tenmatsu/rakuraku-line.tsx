"use client";

/**
 * 顛末書・専決決裁書・捺印決裁書の画面の「楽楽精算」の1行（2026-09-25）。
 *
 * ★ログインの小窓とヘッダーの「楽楽精算: ログイン中／未ログイン」は無くした。
 *   IDとパスワードはアカウントの画面で一度だけ登録し、取得のときに Folio が自動でログインする。
 * ★ここは状態を出すだけ。直すのはアカウントの画面（リンクで移る）。
 */
import Link from "next/link";
import { CREDENTIAL_TEXT, type CredentialView } from "@/lib/rakuraku-credential";

/** アカウントの画面の楽楽精算の欄 */
export const RAKURAKU_ACCOUNT_HREF = "/account#rakuraku";

const LINK_CLASS = "ml-1 font-medium underline";

export function RakurakuLine({
  id,
  view,
  idHint,
  loggedIn,
  loginBusy,
  problem,
}: {
  id: string;
  view: CredentialView;
  idHint: string | null;
  loggedIn: boolean;
  loginBusy: boolean;
  /** 最後のログインの失敗の文（無ければ null） */
  problem: string | null;
}) {
  const hint = idHint ? `（ID ${idHint}）` : "";
  const base = "mt-2 scroll-mt-4 rounded-md px-3 py-2 text-sm";
  if (loginBusy) {
    return (
      <p id={id} tabIndex={-1} className={`${base} border border-slate-200 bg-slate-50 text-slate-700`}>
        楽楽精算にログインしています{hint}…
      </p>
    );
  }
  if (loggedIn) {
    return (
      <p id={id} tabIndex={-1} className="mt-2 scroll-mt-4 text-xs text-slate-500">
        楽楽精算: ログインしています{hint}。
      </p>
    );
  }
  if (view === "checking") {
    return (
      <p id={id} tabIndex={-1} className="mt-2 scroll-mt-4 text-xs text-slate-500">
        楽楽精算: 登録を確かめています…
      </p>
    );
  }
  if (view === "ready") {
    return (
      <div id={id} tabIndex={-1} className="scroll-mt-4">
        <p className="mt-2 text-xs text-slate-500">
          楽楽精算: {CREDENTIAL_TEXT.ready.replace("登録済みです。", `登録済み${hint}。`)}
        </p>
        {/* ★つながらない・混み合いなど、登録のせいではない失敗（押し直せば通る） */}
        {problem && <p className={`${base} border border-amber-300 bg-amber-50 text-amber-800`}>{problem}</p>}
      </div>
    );
  }
  const tone =
    view === "rejected"
      ? "border border-red-300 bg-red-50 text-red-800"
      : "border border-amber-300 bg-amber-50 text-amber-900";
  const text = view === "rejected" ? (problem ?? CREDENTIAL_TEXT.rejected) : CREDENTIAL_TEXT[view];
  return (
    <p id={id} tabIndex={-1} className={`${base} ${tone}`}>
      楽楽精算: {text}
      <Link href={RAKURAKU_ACCOUNT_HREF} className={LINK_CLASS}>
        {view === "none" ? "アカウントの画面で登録する" : "アカウントの画面で入れ直す"}
      </Link>
    </p>
  );
}
