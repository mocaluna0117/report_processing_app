"use client";

/**
 * アカウントの管理（管理者だけ。/account の下）。
 * ★仮のパスワードは、作った・発行したときに1回だけ小窓に出す。閉じたら画面からも消す。
 * ★サーバー（/api/accounts）が毎回、管理者かどうかを確かめる。ここでの表示は目安だけ。
 */
import { useCallback, useEffect, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import type { AdminResponse } from "@/lib/account/admin";
import { accountStatusText, adminConfirmText, createBlocker, roleText } from "@/lib/account/admin-view";
import { TEMP_PASSWORD_NOTE } from "@/lib/account/messages";
import type { AccountSummary } from "@/lib/account/record";

const INPUT_CLASS = "mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm";
const SMALL_BUTTON =
  "cursor-pointer whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-default disabled:opacity-50";
const TONE_CLASS = { ok: "text-emerald-700", warn: "text-amber-800", off: "text-slate-500" } as const;

async function call(method: "GET" | "POST", body?: unknown): Promise<AdminResponse> {
  try {
    const res = await fetch("/api/accounts", {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
      return { ok: false, message: "ログインが切れました。画面を読み込み直してください" };
    }
    return (await res.json()) as AdminResponse;
  } catch {
    return { ok: false, message: "送れませんでした（ネットにつながっているか確かめてください）" };
  }
}

export function AccountAdmin({ selfId }: { selfId: string }) {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [temp, setTemp] = useState<{ id: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const apply = useCallback((result: AdminResponse) => {
    if (result.accounts) setAccounts(result.accounts);
    if (result.message) setMessage({ ok: result.ok, text: result.message });
    if (result.tempPassword && result.tempFor) {
      setCopied(false);
      setTemp({ id: result.tempFor, password: result.tempPassword });
    }
  }, []);

  useEffect(() => {
    void call("GET").then(apply);
  }, [apply]);

  const run = async (body: unknown) => {
    setBusy(true);
    setMessage(null);
    apply(await call("POST", body));
    setBusy(false);
  };

  const blocker = createBlocker({ id: newId, name: newName, busy, existing: (accounts ?? []).map((a) => a.id) });
  const now = Date.now();

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">アカウントの管理</h2>
      <p className="mt-1 text-sm text-slate-600">
        管理者だけに出ています。人を足す・パスワードを忘れた人に仮のパスワードを出す・止める、ができます。
      </p>

      {message && (
        <p
          className={`mt-3 rounded px-2 py-1.5 text-sm ${message.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-700"}`}
        >
          {message.text}
        </p>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="border-b border-slate-200 px-3 py-2">表示名</th>
              <th className="border-b border-slate-200 px-3 py-2">ログインID</th>
              <th className="border-b border-slate-200 px-3 py-2">役割</th>
              <th className="border-b border-slate-200 px-3 py-2">状態</th>
              <th className="border-b border-slate-200 px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts === null ? (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-slate-500">
                  読み込んでいます…
                </td>
              </tr>
            ) : (
              accounts.map((account) => {
                const status = accountStatusText(account, now);
                const self = account.id === selfId;
                return (
                  <tr key={account.id} className="align-top">
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2 font-medium">{account.name}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2 font-mono text-xs">{account.id}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2">{roleText(account)}</td>
                    <td className={`border-b border-slate-100 px-3 py-2 ${TONE_CLASS[status.tone]}`}>{status.text}</td>
                    <td className="border-b border-slate-100 px-3 py-2">
                      {self ? (
                        <span className="text-xs text-slate-400">自分（パスワード・表示名は上の欄で変えます）</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            className={SMALL_BUTTON}
                            onClick={() => {
                              const name = prompt(`「${account.name}」（${account.id}）の新しい表示名`, account.name);
                              if (name !== null && name.trim() !== "" && name.trim() !== account.name) {
                                void run({ action: "rename", id: account.id, name: name.trim() });
                              }
                            }}
                          >
                            名前を変える
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            className={SMALL_BUTTON}
                            onClick={() => {
                              if (confirm(adminConfirmText("reset", account))) void run({ action: "reset", id: account.id });
                            }}
                          >
                            仮のパスワードを発行
                          </button>
                          {account.disabled ? (
                            <button
                              type="button"
                              disabled={busy}
                              className={SMALL_BUTTON}
                              onClick={() => void run({ action: "enable", id: account.id })}
                            >
                              再開
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              className={SMALL_BUTTON}
                              onClick={() => {
                                if (confirm(adminConfirmText("disable", account))) void run({ action: "disable", id: account.id });
                              }}
                            >
                              止める
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            className={`${SMALL_BUTTON} text-red-700`}
                            onClick={() => {
                              if (confirm(adminConfirmText("delete", account))) void run({ action: "delete", id: account.id });
                            }}
                          >
                            消す
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <form
        className="mt-4 rounded-lg border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (blocker) return;
          void run({ action: "create", id: newId, name: newName }).then(() => {
            setNewId("");
            setNewName("");
          });
        }}
      >
        <h3 className="text-sm font-semibold">人を足す</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">ログインID</span>
            <span className="ml-2 text-xs text-slate-500">半角の英小文字・数字（例: 名字のローマ字）</span>
            <input value={newId} onChange={(e) => setNewId(e.target.value)} autoComplete="off" spellCheck={false} className={INPUT_CLASS} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">表示名</span>
            <span className="ml-2 text-xs text-slate-500">右上に出る名前（例: 名字）</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" className={INPUT_CLASS} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          {blocker && (newId !== "" || newName !== "") && <p className="text-xs text-slate-500">{blocker}</p>}
          <button
            type="submit"
            disabled={blocker !== null}
            className="cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            作って仮のパスワードを出す
          </button>
        </div>
      </form>

      {temp && (
        <ModalShell
          label="仮のパスワード"
          onClose={() => setTemp(null)}
          panelClassName="w-full max-w-md rounded-xl bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="text-lg font-bold text-slate-900">仮のパスワード</h2>
            <button
              type="button"
              onClick={() => setTemp(null)}
              aria-label="閉じる"
              className="cursor-pointer rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              ✕
            </button>
          </div>
          <div className="px-5 py-4">
            <p className="text-sm text-slate-600">
              ログインID: <span className="font-mono font-semibold text-slate-900">{temp.id}</span>
            </p>
            <p className="mt-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-3 text-center font-mono text-2xl tracking-wider text-slate-900">
              {temp.password}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-amber-900">★{TEMP_PASSWORD_NOTE}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={SMALL_BUTTON}
                onClick={() => {
                  void navigator.clipboard.writeText(temp.password).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? "コピーしました" : "コピー"}
              </button>
              <button
                type="button"
                onClick={() => setTemp(null)}
                className="cursor-pointer rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                伝えたので閉じる
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
