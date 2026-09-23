"use client";

import { MoreDetails } from "@/components/more-details";
import type { SharedFolderHook } from "@/lib/shared/use-shared-folder";
import { sharedStatus } from "@/lib/shared/status";

const TONE_CLASS = {
  idle: "border-slate-200 bg-white",
  ok: "border-emerald-200 bg-emerald-50/50",
  warn: "border-amber-300 bg-amber-50",
} as const;

const BUTTON =
  "whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-default disabled:opacity-50";

/**
 * 共有フォルダー（Box Drive などで見えるフォルダー）の欄。
 *
 * ★何をする欄かを最初の1行で言う。押せない理由は title ではなく画面にも出す
 *   （「押せません」の問い合わせが多いので、使い方ページと同じ扱いにする）。
 * ★まだ空のフォルダーへは、確認のボタンを押すまで書き出さない。
 */
export function SharedFolderPanel({
  id,
  shared,
  canPersist,
  inDialog = false,
}: {
  shared: SharedFolderHook;
  canPersist: boolean;
  /** 手順バーから飛んでくるときの目印 */
  id?: string;
  /** ヘッダーのモーダルの中に出す（見出しはモーダルの側にあるので出さない） */
  inDialog?: boolean;
}) {
  const view = sharedStatus({
    state: shared.state,
    folderName: shared.folderName,
    lastSync: shared.lastSync,
    syncing: shared.syncing,
    error: shared.error,
    report: shared.report,
    canPersist,
  });

  return (
    <section
      id={id}
      tabIndex={-1}
      className={`scroll-mt-4 rounded-lg border ${inDialog ? "p-3" : "p-4"} ${TONE_CLASS[view.tone]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {!inDialog && <h2 className="text-lg font-semibold">共有フォルダー</h2>}
          <p className={`${inDialog ? "" : "mt-0.5 "}break-words text-sm text-slate-600`}>{view.headline}</p>
          {view.notes.map((note) => (
            <p key={note} className="mt-0.5 break-words text-xs text-slate-500">
              {note}
            </p>
          ))}
          <MoreDetails size="xs" summary="くわしく (共有するもの・しないもの)">
            <p>
              共有フォルダーの中の <strong>_data</strong> に置くのは、顧客データの<strong>台帳</strong>（氏名・住所・電話番号を含みます）とその<strong>手直し</strong>、伏せ字済みの<strong>学習した書き方</strong>です。
            </p>
            <p>
              受付一覧・受付メモの原文・定期点検のPDFと抽出結果は置きません。顛末書・専決決裁書・捺印決裁書のPDFも置きません（各自のPCのフォルダーに保存します）。閲覧できる人は、そのフォルダーの権限どおりです。
            </p>
            <p>
              もう1台はフォルダーを選ぶだけで台帳ごと受け取れます。顧客データが増えたときは、アフターメンテナンスの「顧客データ」の枠に xlsx / csv をドロップすると、共有フォルダーにも置かれます。
            </p>
          </MoreDetails>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {shared.state !== "unsupported" && (
            <button type="button" onClick={() => void shared.choose()} className={BUTTON}>
              {shared.state === "none" ? "共有フォルダーを選ぶ" : "別のフォルダーを選ぶ"}
            </button>
          )}
          {(shared.state === "prompt" || shared.state === "error") && shared.folderName && (
            <button
              type="button"
              onClick={() => void shared.connect()}
              className="whitespace-nowrap rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              共有フォルダーにつなぐ
            </button>
          )}
          <button
            type="button"
            disabled={!view.canSync}
            title={view.syncReason}
            onClick={() => void shared.sync()}
            className={BUTTON}
          >
            {shared.syncing ? "同期しています…" : "共有フォルダーと同期"}
          </button>
          {shared.state !== "none" && shared.state !== "unsupported" && (
            <button
              type="button"
              onClick={() => void shared.forget()}
              title="この端末の登録だけを消します。フォルダーの中のファイルは消しません"
              className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              登録を消す
            </button>
          )}
        </div>
      </div>

      {view.ledgerReplace && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p>{view.ledgerReplace}</p>
          <button
            type="button"
            disabled={shared.syncing}
            onClick={() => void shared.sync({ allowLedgerReplace: true })}
            className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            共有フォルダーの顧客ファイルを取り込む
          </button>
        </div>
      )}

      {view.firstWrite && (
        <div className="mt-3 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <p>{view.firstWrite}</p>
          <button
            type="button"
            disabled={shared.syncing}
            onClick={() => void shared.sync({ allowFirstWrite: true })}
            className="mt-2 rounded-md border border-sky-400 bg-white px-3 py-1.5 text-sm font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
          >
            このフォルダーへ書き出す
          </button>
        </div>
      )}
    </section>
  );
}
