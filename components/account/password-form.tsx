"use client";

/**
 * パスワードを決める・変える欄。
 * ★送信は普通のフォームの POST（fetch にしない）。画面が移るので、ブラウザの「パスワードを保存」が効く。
 * ★決まりは lib/account/policy.ts。サーバーでも同じ決まりで確かめ直す。
 */
import { useState } from "react";
import { PASSWORD_MIN, passwordProblems } from "@/lib/account/policy";

const INPUT_CLASS = "mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm";

export function PasswordForm({
  loginId,
  forced,
  next,
}: {
  loginId: string;
  /** 仮のパスワードで入った人（今のパスワードは聞かない） */
  forced: boolean;
  next: string;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [sending, setSending] = useState(false);

  const problems =
    password === "" && confirm === ""
      ? []
      : passwordProblems({ password, confirm, loginId, current: forced ? null : current });
  const blocker = sending
    ? "送っています"
    : !forced && current === ""
      ? "今のパスワードを入れてください"
      : password === ""
        ? `新しいパスワードを入れてください（${PASSWORD_MIN}文字以上）`
        : (problems[0] ?? null);

  return (
    <form
      method="post"
      action="/api/account/password"
      onSubmit={(e) => {
        if (blocker) {
          e.preventDefault();
          return;
        }
        setSending(true);
      }}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      {/* ブラウザのパスワード保存が、どのIDのものか分かるように */}
      <input type="text" name="username" value={loginId} autoComplete="username" readOnly hidden />
      <input type="hidden" name="next" value={next} />
      {!forced && (
        <label className="block text-sm">
          <span className="font-medium">今のパスワード</span>
          <input
            type="password"
            name="current"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className={INPUT_CLASS}
          />
        </label>
      )}
      <label className={`block text-sm ${forced ? "" : "mt-3"}`}>
        <span className="font-medium">新しいパスワード</span>
        <span className="ml-2 text-xs text-slate-500">{PASSWORD_MIN}文字以上。記号や大文字は無くて構いません</span>
        <input
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          // biome-ignore lint/a11y/noAutofocus: パスワードを決めるための画面なので、すぐ打てるようにする
          autoFocus={forced}
          className={INPUT_CLASS}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="font-medium">新しいパスワード（確認のためもう一度）</span>
        <input
          type="password"
          name="confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={INPUT_CLASS}
        />
      </label>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {blocker && <p className="text-xs text-slate-500">{blocker}</p>}
        <button
          type="submit"
          disabled={blocker !== null}
          className="cursor-pointer rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "変えています…" : forced ? "このパスワードにする" : "パスワードを変える"}
        </button>
      </div>
    </form>
  );
}
