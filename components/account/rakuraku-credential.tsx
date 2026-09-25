"use client";

/**
 * アカウントの画面の「楽楽精算のIDとパスワード（取得に使う）」（2026-09-25 の利用者の決定）。
 *
 * ★保存するのはこのPCのこのブラウザの中だけ（Folio のサーバーの鍵で暗号にした控え）。社外のクラウドには置かない。
 * ★「ログインできるか確かめて保存」: サーバーが1回だけログインしてみて、できたときだけ控えを作る（打ち間違いを残さない）。
 * ★本人だけが自分の分を入れる（説明にも書く）。管理者がほかの人の分を入れる・見る道は無い。
 * ★<form> にしない（ブラウザが Folio のパスワードの保存先と取り違えないように）。欄の自動入力も断る。
 *   それでも Folio のパスワードが入ってしまったときは、サーバーが送る前に断る。
 * ★取得の最中は、保存・消すを押せない（取得が使っているログインを入れ替えない）。
 */
import { useEffect, useState } from "react";
import {
  CREDENTIAL_TEXT,
  type CredentialServerState,
  type StoredRakurakuCredential,
  credentialView,
  deleteCredential,
  fetchCredentialState,
  loadCredential,
  verifyAndSaveCredential,
} from "@/lib/rakuraku-credential";
import { activeRunKind } from "@/lib/tenmatsu/local/client";
import { clearLoginProblem, forgetLogin, setLogin } from "@/lib/tenmatsu/local/session";

const INPUT_CLASS = "mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50";
const PRIMARY_CLASS =
  "cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_CLASS =
  "cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

/** 画面に出す説明（利用者の決定。本人が分かっている形にする） */
export const RAKURAKU_CREDENTIAL_LEAD = [
  "顛末書・専決決裁書・捺印決裁書を楽楽精算から取得するとき、Folio がこのIDとパスワードで代わりにログインします。",
  "保存するのは、このPCのこのブラウザの中だけです（暗号にして保存します。鍵は Folio のサーバーにあるので、PCの中身だけでは読めません。社外のクラウドには保存しません）。",
  "ほかの人の分は入れないでください。別のPCで使うときは、そのPCでもう一度入れてください。",
];

const stamp = (ms: number | null) =>
  ms === null
    ? null
    : new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function RakurakuCredentialSection({ owner }: { owner: string }) {
  const [stored, setStored] = useState<StoredRakurakuCredential | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [server, setServer] = useState<CredentialServerState | null>(null);
  const [editing, setEditing] = useState(false);
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runActive, setRunActive] = useState(false);

  useEffect(() => {
    let alive = true;
    setRunActive(activeRunKind() !== null);
    void (async () => {
      const found = await loadCredential(owner);
      if (!alive) return;
      setStored(found);
      setLoaded(true);
      const state = await fetchCredentialState();
      if (alive) setServer(state);
    })();
    return () => {
      alive = false;
    };
  }, [owner]);

  const view = credentialView({ loaded, stored, server });
  const showForm = loaded && (editing || view === "none");
  const blocked = busy || runActive;
  const blockedReason = runActive ? "取得の最中は変えられません。取得が終わってから押してください" : undefined;

  const save = async () => {
    setError(null);
    setNotice(null);
    if (!userId.trim() || !password) {
      setError("楽楽精算のログインIDとパスワードを入れてください");
      return;
    }
    setBusy(true);
    try {
      const result = await verifyAndSaveCredential({ userId: userId.trim(), password }, owner);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setStored(result.stored);
      setServer({ ver: result.stored.ver, failures: 0, lastOkAt: Date.now(), lastFailAt: null, lastFailReason: null, busy: false });
      // ★このタブのログインは、いま確かめたときのものに入れ替える（次の取得ですぐ使える）
      forgetLogin();
      setLogin(result.session);
      clearLoginProblem();
      setEditing(false);
      setUserId("");
      setNotice("楽楽精算にログインできたので、このPCに登録しました。取得のときは自動でログインします。");
    } finally {
      // ★パスワードは画面の中にも残さない
      setPassword("");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("このPCの楽楽精算のIDとパスワードの登録を消します。取得するときは、また登録が要ります。よろしいですか？")) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await deleteCredential(owner);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      forgetLogin();
      setStored(null);
      setServer(null);
      setEditing(false);
      setNotice("このPCの登録を消しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="rakuraku" tabIndex={-1} className="scroll-mt-4">
      <h2 className="mt-8 text-lg font-semibold">楽楽精算のIDとパスワード（取得に使う）</h2>
      <div className="mt-2 space-y-1 text-xs text-slate-600">
        {RAKURAKU_CREDENTIAL_LEAD.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </div>

      <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        {!loaded ? (
          <p className="text-sm text-slate-500">このPCの登録を確かめています…</p>
        ) : view === "none" ? (
          <p className="text-sm text-slate-700">{CREDENTIAL_TEXT.none}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-800">
              このPCに登録しています（ID {stored?.idHint}
              {stored && `・登録 ${stamp(stored.savedAt)}`}
              {server?.lastOkAt ? `・最後にログインできた ${stamp(server.lastOkAt)}` : ""}）
            </p>
            {view === "rejected" && (
              <p className="rounded bg-red-50 px-2 py-1.5 text-sm text-red-800">
                {CREDENTIAL_TEXT.rejected}楽楽精算のパスワードを変えたときは、「入れ直す」から入れてください。
              </p>
            )}
            {view === "stale" && <p className="rounded bg-amber-50 px-2 py-1.5 text-sm text-amber-900">{CREDENTIAL_TEXT.stale}</p>}
            {!editing && (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setEditing(true)} disabled={blocked} title={blockedReason} className={SECONDARY_CLASS}>
                  入れ直す
                </button>
                <button type="button" onClick={() => void remove()} disabled={blocked} title={blockedReason} className={SECONDARY_CLASS}>
                  このPCから消す
                </button>
              </div>
            )}
          </div>
        )}

        {showForm && (
          <div className="mt-3 max-w-sm">
            <label className="block text-sm">
              <span className="font-medium">楽楽精算のログインID</span>
              <input
                name="rakuraku-login-id"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>
            <label className="mt-3 block text-sm">
              <span className="font-medium">楽楽精算のパスワード</span>
              <input
                type="password"
                name="rakuraku-secret"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !blocked) void save();
                }}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                disabled={busy}
                className={INPUT_CLASS}
              />
            </label>
            <p className="mt-2 text-xs text-slate-500">
              押すと、楽楽精算に1回だけログインして確かめます（10秒ほどかかります）。ログインできたときだけ登録します。
              できなかったときも自動ではやり直しません（楽楽精算のアカウントがロックされないように）。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void save()} disabled={blocked} title={blockedReason} className={PRIMARY_CLASS}>
                {busy ? "楽楽精算にログインして確かめています…" : "ログインできるか確かめて保存"}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setPassword("");
                    setError(null);
                  }}
                  disabled={busy}
                  className={SECONDARY_CLASS}
                >
                  やめる
                </button>
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-3 rounded bg-red-50 px-2 py-1.5 text-sm text-red-700">{error}</p>}
        {notice && <p className="mt-3 rounded bg-emerald-50 px-2 py-1.5 text-sm text-emerald-900">{notice}</p>}
        {runActive && <p className="mt-3 text-xs text-slate-500">{blockedReason}</p>}
      </div>
    </section>
  );
}
