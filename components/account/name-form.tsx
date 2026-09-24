"use client";

/**
 * 自分の表示名を変える欄（右上の「👤 名前」と、問い合わせのお名前に使う）。
 * 送信は普通のフォームの POST（/api/account/name）。決まりは lib/account/policy.ts。
 */
import { useState } from "react";
import { DISPLAY_NAME_MAX, displayNameProblem } from "@/lib/account/policy";

export function NameForm({ current }: { current: string }) {
  const [name, setName] = useState(current);
  const [sending, setSending] = useState(false);
  const blocker = sending
    ? "送っています"
    : name.trim() === current
      ? "今と同じ表示名です"
      : displayNameProblem(name);

  return (
    <form
      method="post"
      action="/api/account/name"
      onSubmit={(e) => {
        if (blocker) {
          e.preventDefault();
          return;
        }
        setSending(true);
      }}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <label className="block text-sm">
        <span className="font-medium">表示名</span>
        <span className="ml-2 text-xs text-slate-500">右上に出る名前（{DISPLAY_NAME_MAX}文字まで）。問い合わせのお名前にも入ります</span>
        <input
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={DISPLAY_NAME_MAX * 2}
          autoComplete="nickname"
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        {blocker && name.trim() !== current && <p className="text-xs text-slate-500">{blocker}</p>}
        <button
          type="submit"
          disabled={blocker !== null}
          className="cursor-pointer rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "変えています…" : "表示名を変える"}
        </button>
      </div>
    </form>
  );
}
