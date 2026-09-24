import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { AccountAdmin } from "@/components/account/account-admin";
import { NameForm } from "@/components/account/name-form";
import { PasswordForm } from "@/components/account/password-form";
import { MUST_CHANGE_TEXT, NAME_CHANGED_TEXT, PASSWORD_CHANGED_TEXT, changeErrorText } from "@/lib/account/messages";
import { accountPageState } from "@/lib/account/page-state";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";
import { SESSION_COOKIE, safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "アカウント — Folio" };
export const dynamic = "force-dynamic";

/**
 * 自分のアカウント（パスワードを決める・変える）と、管理者だけのアカウントの管理。
 * 仮のパスワードで入った人は、ここでパスワードを決めるまでほかの画面を使えない（proxy.ts の門番）。
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; p?: string; done?: string; next?: string }>;
}) {
  const { error, p, done, next } = await searchParams;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const state = await accountPageState(currentAuthConfig(), token, accountStoreFor, Math.floor(Date.now() / 1000));
  const errors = changeErrorText(error, p);

  return (
    <main className="mx-auto mt-8 max-w-3xl">
      {state.kind === "off" && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          この環境では、一人ずつのアカウントを使っていません（手元の開発）。
        </p>
      )}
      {state.kind === "legacy" && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          いまは、前の共通の合言葉でログインしています。管理者から受け取った自分のログインIDで入り直してください（右上の「Folio からログアウト」を押してから）。
        </p>
      )}
      {state.kind === "expired" && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          ログインが切れました。
          <Link href="/login?next=%2Faccount" className="ml-1 font-medium text-blue-700 underline">
            もう一度ログイン
          </Link>
          してください。
        </p>
      )}
      {state.kind === "unavailable" && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          いまアカウントを確かめられません。少し待ってから読み込み直してください。
        </p>
      )}
      {state.kind === "account" && (
        <>
          <h1 className="text-xl font-bold text-slate-900">
            {state.record.name}
            <span className="ml-2 font-mono text-sm font-normal text-slate-500">{state.record.id}</span>
          </h1>
          {state.forced ? (
            <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{MUST_CHANGE_TEXT}</p>
          ) : (
            (done === "1" || done === "name") && (
              <p className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                {done === "name" ? NAME_CHANGED_TEXT : PASSWORD_CHANGED_TEXT}
              </p>
            )
          )}
          {errors.length > 0 && (
            <ul className="mt-3 list-disc rounded bg-red-50 py-2 pl-7 pr-3 text-sm text-red-700">
              {errors.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          )}
          <h2 className="mt-6 text-lg font-semibold">{state.forced ? "自分のパスワードを決める" : "パスワードを変える"}</h2>
          <div className="mt-2">
            <PasswordForm loginId={state.record.id} forced={state.forced} next={safeNextPath(next)} />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            変えると、ほかの端末でログインしていた分は5分ほどで切れます。忘れたときは、管理者に仮のパスワードを発行してもらってください。
          </p>
          {/* ★表示名は、パスワードを決めたあとに変えられる */}
          {!state.forced && (
            <>
              <h2 className="mt-8 text-lg font-semibold">表示名を変える</h2>
              <div className="mt-2">
                <NameForm current={state.record.name} />
              </div>
            </>
          )}
          {state.record.role === "admin" && !state.forced && <AccountAdmin selfId={state.record.id} />}
        </>
      )}
    </main>
  );
}
