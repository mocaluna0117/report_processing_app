import type { Metadata } from "next";
import {
  FORGOT_PASSWORD_TEXT,
  LOGIN_EXPIRED_TEXT,
  LOGIN_LEAD_TEXT,
  SIGNED_OUT_TEXT,
  loginErrorText,
} from "@/lib/account/messages";
import { safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "ログイン — Folio" };

/**
 * ログイン画面（一人ずつのアカウント。2026-09-24）。
 *
 * ブラウザ標準の Basic認証ダイアログではパスワードマネージャーが働かないので、
 * 通常のHTMLフォームにしている (autocomplete を付けて保存・自動入力が効くようにする)。
 * 送信は fetch ではなく普通のPOSTにする — 画面遷移を伴う送信でないと、
 * ブラウザが「パスワードを保存しますか」を出さないため。
 * ★誰でも開ける画面なので、ログインIDを最初から入れておかない（ID を見せない）。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; expired?: string; "signed-out"?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const error = loginErrorText(params.error);
  const notice = error ? null : params.expired ? LOGIN_EXPIRED_TEXT : params["signed-out"] ? SIGNED_OUT_TEXT : null;

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <p className="text-sm text-slate-600">{LOGIN_LEAD_TEXT}</p>

      <form
        method="post"
        action="/api/login"
        className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        {/* ログイン後に元の画面へ戻す */}
        <input type="hidden" name="next" value={next === "/" ? "" : next} />
        {error && <p className="mb-3 rounded bg-red-50 px-2 py-1.5 text-sm text-red-700">{error}</p>}
        {notice && <p className="mb-3 rounded bg-slate-100 px-2 py-1.5 text-sm text-slate-700">{notice}</p>}
        <label className="block text-sm">
          <span className="font-medium">ログインID</span>
          <input
            name="user"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            // biome-ignore lint/a11y/noAutofocus: この画面ではIDを入れることしかしない
            autoFocus
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="mt-3 block text-sm">
          <span className="font-medium">パスワード</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          className="mt-4 w-full cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
        >
          ログイン
        </button>
      </form>

      <p className="mt-3 text-xs text-slate-500">{FORGOT_PASSWORD_TEXT}</p>
      <p className="mt-1 text-xs text-slate-400">
        このブラウザではログインしたままになります (共有の端末では、使い終わったら画面右上の人の形のアイコンから「Folio からログアウト」を押してください)。
      </p>
    </main>
  );
}
