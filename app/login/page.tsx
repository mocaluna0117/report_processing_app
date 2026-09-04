import type { Metadata } from "next";

export const metadata: Metadata = { title: "ログイン — Folio" };

/**
 * ログイン画面。
 *
 * ブラウザ標準の Basic認証ダイアログではパスワードマネージャーが働かないので、
 * 通常のHTMLフォームにしている (autocomplete を付けて保存・自動入力が効くようにする)。
 * 送信は fetch ではなく普通のPOSTにする — 画面遷移を伴う送信でないと、
 * ブラウザが「パスワードを保存しますか」を出さないため。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const defaultUser = process.env.APP_USER || "user";

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <p className="text-sm text-slate-600">顧客情報を扱うため、パスワードで保護しています。</p>

      <form
        method="post"
        action="/api/login"
        className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        {/* ログイン後に元の画面へ戻す */}
        <input type="hidden" name="next" value={next ?? ""} />
        {error && (
          <p className="mb-3 rounded bg-red-50 px-2 py-1.5 text-sm text-red-700">
            ユーザー名かパスワードが違います
          </p>
        )}
        <label className="block text-sm">
          <span className="font-medium">ユーザー名</span>
          <input
            name="user"
            defaultValue={defaultUser}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="mt-3 block text-sm">
          <span className="font-medium">パスワード</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            // biome-ignore lint/a11y/noAutofocus: パスワードだけ入れれば済むので入力欄に合わせる
            autoFocus
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

      <p className="mt-3 text-xs text-slate-400">
        このブラウザではログインしたままになります (共有の端末では、使い終わったら画面右上の「ログアウト」を押してください)。
      </p>
    </main>
  );
}
