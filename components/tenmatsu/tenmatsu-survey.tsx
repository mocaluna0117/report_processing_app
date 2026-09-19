"use client";

// 「画面の下見」: 楽楽精算の画面の作りだけを集めて、開発者へ貼ってもらう文面にする。
//
// ★アカウントによって使える画面が違う（「閲覧」タブが無い人は「ワークフロー」から取る）。
//   その人の画面はこちらからは見えないので、本人に集めてもらうための道具。
// ★集めるのは画面の作りだけ。伝票の中身・伝票No.・氏名・金額・楽楽精算のURLは入らない。
// ★結果はこのブラウザの画面にだけ出る（保存も送信もしない）。
import { useRef, useState } from "react";
import { TenmatsuRunLog } from "@/components/tenmatsu/tenmatsu-run-log";
import { formatSurveyReport } from "@/lib/rakuraku/parse/survey";
import type { RunLogLine } from "@/lib/tenmatsu/client";
import type { RakurakuApi } from "@/lib/tenmatsu/local/server-api";

const BUTTON_CLASS =
  "cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

export function TenmatsuSurvey({
  api,
  sessionToken,
  deptCode,
  onSession,
  disabled,
  disabledReason,
}: {
  api: RakurakuApi;
  /** 楽楽精算のログイン状態（無ければ実行できない） */
  sessionToken: string | null;
  deptCode: string | null;
  /** 新しいログイン状態を受け取ったら差し替える */
  onSession: (token: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<RunLogLine[]>([]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const seqRef = useRef(0);

  const print = (line: string) => {
    seqRef.current += 1;
    setLines((prev) => [...prev, { seq: seqRef.current, text: line }]);
  };

  const run = async () => {
    if (!sessionToken) return;
    setBusy(true);
    setError(null);
    setText(null);
    setCopied(false);
    seqRef.current = 0;
    setLines([]);
    try {
      const report = await api.survey(
        { sessionToken, deptCode },
        { log: print, progress: (_stage, message) => print(message), session: onSession },
      );
      setText(formatSurveyReport(report));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("コピーできませんでした。枠の中の文字を選んでコピーしてください");
    }
  };

  return (
    <details className="mt-3 rounded-lg border border-slate-200 p-3 text-sm">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        画面の下見（楽楽精算の画面の作りを開発者へ伝える）
      </summary>
      <p className="mt-2 text-xs text-slate-600">
        アカウントによって楽楽精算の画面が違うため、うまく一覧を開けないときに使います。
        ボタンを押すと、メニューの文字・一覧の場所・表の見出し・伝票画面の部品の数だけを集めて、下に文面を出します。
        その文面を開発者へ送ってください（数分かかります）。
      </p>
      <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">
        <li>集めないもの: 伝票の内容・伝票No.・氏名・金額・表の値・楽楽精算のURL</li>
        <li>押すもの: 「ワークフロー」「押印の申請」のタブだけ（申請・承認・データを変える操作はしません）</li>
        <li>結果はこの画面に出るだけで、保存も送信もしません</li>
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || disabled || !sessionToken}
          title={!sessionToken ? "楽楽精算にログインしてください" : disabledReason}
          className={BUTTON_CLASS}
        >
          {busy ? "調べています…" : "下見を実行"}
        </button>
        {text && (
          <button type="button" onClick={() => void copy()} className={BUTTON_CLASS}>
            {copied ? "コピーしました" : "文面をコピー"}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}
      {lines.length > 0 && <TenmatsuRunLog lines={lines} />}
      {text && (
        <textarea
          readOnly
          value={text}
          rows={16}
          className="mt-2 w-full rounded border border-slate-300 bg-slate-50 p-2 font-mono text-xs"
        />
      )}
    </details>
  );
}
