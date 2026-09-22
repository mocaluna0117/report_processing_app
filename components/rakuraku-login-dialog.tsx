"use client";

/**
 * 楽楽精算のログイン（Folio 全体で1つ。ヘッダーから開く）。
 *
 * ★★ ログインは**このフォームを送信したときだけ**行う。useEffect からは絶対に呼ばない。★★
 *    楽楽精算は続けて失敗するとアカウントがロックされる。Folio は1回試して駄目なら
 *    理由を出して止まり、人に判断を委ねる（lib/rakuraku/login.ts と同じ規則）。
 *    tests/rakuraku-login-dialog.test.ts がこのファイルの中身を読んで見張っている。
 * ★パスワードはメモリにだけ置く（保存しない）。ログインIDはこのブラウザに覚える。
 * ★部門はここでは読まない。画面（tenmatsu-folder-page.tsx）が、ログインの変化を受けて
 *   自分の種類の分だけ読みに行く。
 */
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import {
  LOGIN_RULE_TEXT,
  clearLoginDismissal,
  closeLoginDialog,
  getLoginDialogState,
  loginDialogCopy,
  markLoginDismissedInTab,
  shouldAutoCloseLogin,
  subscribeLoginDialog,
} from "@/lib/rakuraku-login-dialog";
import { isStorageAvailable } from "@/lib/storage";
import { hasActiveRun } from "@/lib/tenmatsu/local/active-run";
import {
  forgetLogin,
  getLoginUserId,
  getPassword,
  getSessionToken,
  setLogin,
  subscribeLogin,
} from "@/lib/tenmatsu/local/session";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";
import { createRakurakuApi } from "@/lib/tenmatsu/local/server-api";
import { loadUserId, saveUserId } from "@/lib/tenmatsu/store";

/** Folio のサーバー（/api/rakuraku/login）。この部品の中で1つ */
const api = createRakurakuApi();

const INPUT_CLASS =
  "rounded border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const ERROR_CLASS = "mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800";

export function RakurakuLoginDialog() {
  const [dialog, setDialog] = useState(getLoginDialogState);
  useEffect(() => subscribeLoginDialog(setDialog), []);

  /** ログインの状態。★初期値は sessionStorage を読まない（サーバーの描画と食い違わせない） */
  const [login, setLoginView] = useState({ loggedIn: false, hasPassword: false, userId: "" });
  useEffect(() => {
    const sync = () =>
      setLoginView((prev) => ({
        loggedIn: getSessionToken() !== null,
        hasPassword: getPassword() !== null,
        userId: getLoginUserId() ?? prev.userId,
      }));
    const stop = subscribeLogin(sync);
    sync();
    return stop;
  }, []);

  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いたら、前に使ったログインIDを入れておく（読むだけ。ログインはしない）
  useEffect(() => {
    if (!dialog.open || !isStorageAvailable()) return;
    let alive = true;
    void loadUserId()
      .then((saved) => {
        if (alive && saved) setUserId((prev) => (prev === "" ? saved : prev));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dialog.open]);

  // 開いたら入力欄に合わせる（IDが入っていればパスワードへ）
  useEffect(() => {
    if (!dialog.open) return;
    setError(null);
    if (login.loggedIn) closeRef.current?.focus();
    else if (userId.trim()) passwordRef.current?.focus();
    else idRef.current?.focus();
    // ★開いた瞬間だけ。入力のたびに合わせ直さない
    // biome-ignore lint/correctness/useExhaustiveDependencies: dialog.open が変わったときだけ見る
  }, [dialog.open, login.loggedIn]);

  // ★ほかの場所（取得の途中の入り直し・別のタブ）でログインできたら、自分から出したものは閉じる
  useEffect(() => {
    if (shouldAutoCloseLogin({ open: dialog.open, reason: dialog.reason, loggedIn: login.loggedIn })) {
      closeLoginDialog();
    }
  }, [dialog.open, dialog.reason, login.loggedIn]);

  if (!dialog.open) return null;

  const kindLabel = DOC_KINDS.find((k) => k.id === dialog.kind)?.label ?? null;
  const copy = loginDialogCopy(dialog.reason, kindLabel);
  const running = hasActiveRun();

  /** ★ログインを呼ぶのはここ1か所だけ。押されたときにしか走らない */
  const submit = async () => {
    const id = userId.trim();
    if (!id || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(id, password);
      setLogin({
        userId: id,
        password,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        viewTab: result.viewTab,
      });
      setPassword("");
      clearLoginDismissal();
      if (isStorageAvailable()) void saveUserId(id).catch(() => undefined);
      closeLoginDialog();
    } catch (e) {
      // ★やり直さない。理由を出して止まる（ロックを避けるため）
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      label={copy.title}
      onClose={closeLoginDialog}
      panelClassName="w-full max-w-lg rounded-xl bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-bold text-slate-900">{copy.title}</h2>
        <button
          ref={closeRef}
          type="button"
          onClick={closeLoginDialog}
          aria-label="閉じる"
          className="cursor-pointer rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          ✕
        </button>
      </div>

      <div className="px-5 py-4">
        {login.loggedIn ? (
          <>
            <p className="text-sm">
              <span className="font-medium text-emerald-700">ログインしています</span>
              {login.userId && <span className="ml-2 text-xs text-slate-500">ID: {login.userId}</span>}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              顛末書・専決決裁書・捺印決裁書で共通です。ログイン状態はこのタブにだけ残り、タブを閉じると消えます (期限は8時間)。
            </p>
            {!login.hasPassword && (
              <p className="mt-2 text-xs text-slate-500">
                取得の途中でログインが切れたときは、パスワードを入れ直していただく必要があります。
              </p>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={running}
                title={running ? "取得が終わってからログアウトしてください" : undefined}
                onClick={() => {
                  forgetLogin();
                  // 押した直後にまた出てこないように（自分で開けばいつでも出せる）
                  markLoginDismissedInTab();
                }}
                className={SECONDARY_BUTTON_CLASS}
              >
                ログアウト (パスワードを忘れる)
              </button>
              <button type="button" onClick={closeLoginDialog} className={PRIMARY_BUTTON_CLASS}>
                閉じる
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">{copy.lead}</p>
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label className="flex flex-col text-xs text-slate-600">
                ログインID
                <input
                  ref={idRef}
                  type="text"
                  value={userId}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUserId(e.target.value)}
                  disabled={busy}
                  className={`mt-1 ${INPUT_CLASS}`}
                />
              </label>
              <label className="flex flex-col text-xs text-slate-600">
                パスワード
                <input
                  ref={passwordRef}
                  type="password"
                  value={password}
                  autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  className={`mt-1 ${INPUT_CLASS}`}
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busy || !userId.trim() || !password}
                  title={!userId.trim() || !password ? "ログインIDとパスワードを入れてください" : undefined}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {busy ? "ログインしています…" : "ログイン"}
                </button>
              </div>
            </form>
            <p className="mt-3 text-xs text-slate-500">{LOGIN_RULE_TEXT}</p>
            {error && <p className={ERROR_CLASS}>{error}</p>}
          </>
        )}
      </div>
    </ModalShell>
  );
}
