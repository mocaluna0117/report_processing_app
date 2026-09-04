"use client";

import { useMemo } from "react";
import { type ListItem, formatFileSize, hasFlags } from "@/lib/tenmatsu/client";
import {
  LIST_FILTERS,
  type ListFilter,
  listCounts,
  visibleListItems,
} from "@/lib/tenmatsu/list-view";

/** 画面から切り替えられる完了フラグ */
export type FlagKey = "budget_entered" | "cloud_stored";

const FLAG_COLUMNS: readonly { key: FlagKey; head: string; label: string }[] = [
  // head は列見出し (列を細く保つため短く)、label は読み上げと補足に使う正式名
  { key: "budget_entered", head: "実行予算", label: "実行予算入力済み" },
  { key: "cloud_stored", head: "クラウド", label: "クラウド格納済み" },
];

const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 見出しのセル。縦スクロールしても残るように1つずつ sticky にする
 * (背景色は tr ではなくセルに付けないと、下の行が透けて見える)。
 */
const TH_CLASS = "sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-3 py-2";

/** 空欄の表示。値が無いことを黙って隠さない */
const dash = (value: string | null | undefined) => (value ? value : "－");

/** 印を最後に変えた日時。列を増やさず title に出す */
const flagsUpdatedTitle = (item: ListItem) =>
  item.flags_updated_at ? `最終更新 ${item.flags_updated_at}` : "まだ変更していません";

/**
 * 取得済み一覧の表と、その見せ方の操作。
 * 絞り込みと完了の非表示は lib/tenmatsu/list-view.ts の純関数に任せる
 * (この repo の vitest は node 環境なので、判定はコンポーネントの外に出して単体テストする)。
 */
export function TenmatsuList({
  items,
  filter,
  onFilterChange,
  showCompleted,
  onShowCompletedChange,
  recentNos,
  savingNos,
  flagDisabledReason,
  onToggleFlag,
  canPreview,
  onPreview,
}: {
  /** /list が返した全行。絞り込みと非表示はこの中で行い、items 自体は書き換えない */
  items: ListItem[];
  filter: ListFilter;
  onFilterChange: (value: ListFilter) => void;
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  /** この画面でチェックを変えた行 (完了になっても読み直すまでは隠さない) */
  recentNos: ReadonlySet<string>;
  /** チェックの変更中の伝票No. */
  savingNos: ReadonlySet<string>;
  /** チェックを触れない理由。null なら触れる */
  flagDisabledReason: string | null;
  onToggleFlag: (no: string, flag: FlagKey, next: boolean) => void;
  canPreview: boolean;
  onPreview: (no: string) => void;
}) {
  const view = useMemo(
    () => ({ filter, showCompleted, keepNos: recentNos }),
    [filter, showCompleted, recentNos],
  );
  const visible = useMemo(() => visibleListItems(items, view), [items, view]);
  const counts = useMemo(() => listCounts(items, view), [items, view]);

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label
          className="flex cursor-pointer items-center gap-1.5 text-sm"
          title="実行予算入力済みとクラウド格納済みの両方にチェックが付いた行のことです"
        >
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => onShowCompletedChange(e.target.checked)}
            className={CHECKBOX_CLASS}
          />
          完了したものも表示
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          絞り込み
          <select
            value={filter}
            // e.target.value は string なので、選択肢から引き当てる
            onChange={(e) => {
              const next = LIST_FILTERS.find((f) => f.value === e.target.value);
              if (next) onFilterChange(next.value);
            }}
            className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {LIST_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {items.length > 0 && (
        <p className="mt-2 text-xs text-slate-500" aria-live="polite">
          {/* 3つの数は必ず全件に分割される (行が消えたのに説明が無い状態を作らないため) */}
          表示 {counts.shown}件 / 完了で非表示 {counts.hiddenCompleted}件 / 絞り込みで非表示{" "}
          {counts.hiddenByFilter}件（全 {counts.total}件）
          {counts.missingFile > 0 && (
            // 絞り込みで見えていなくても件数だけは必ず伝える
            <span className="ml-1 text-amber-700">
              ファイルが消えている記録が {counts.missingFile}件あります
            </span>
          )}
        </p>
      )}

      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">まだ取得した顛末書はありません。</p>
      ) : visible.length === 0 ? (
        // 完了を既定で隠すので、作業が全部済んでいると表が空になる。
        // ここで「まだ取得した顛末書はありません」と出すと嘘になる
        <p className="mt-2 text-sm text-slate-600">
          表示できる行がありません (全 {counts.total}件)。
          {counts.hiddenCompleted > 0 && "「完了したものも表示」で完了した分を出せます。"}
          {counts.hiddenByFilter > 0 && "絞り込みを「すべて」に戻すと全件出ます。"}
        </p>
      ) : (
        // 枠線は外側に持たせ、スクロールするのは表だけにする。
        // 縦もこの中でスクロールさせて、見出しの sticky が枠の中に残るようにする
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          {/* scroll-pt は Tab移動でセルが固定した見出しの下に潜らないための余白 */}
          <div className="max-h-[60vh] scroll-pt-10 overflow-auto">
            {/* min-w は列幅の合計。列を増やしたり幅を変えたらここも直す */}
            <table className="w-full min-w-[1460px] text-sm">
            <thead>
              <tr className="whitespace-nowrap text-left text-xs text-slate-500">
                <th
                  className={`w-32 ${TH_CLASS}`}
                  title="PC側の記録に足した順の逆に並びます (申請日での並べ替えではありません)"
                >
                  伝票No.
                </th>
                <th className={`w-48 ${TH_CLASS}`}>物件名</th>
                {FLAG_COLUMNS.map((col) => (
                  <th key={col.key} className={`w-20 ${TH_CLASS}`} title={col.label}>
                    {col.head}
                  </th>
                ))}
                <th className={`w-24 ${TH_CLASS}`}>申請日</th>
                <th className={`w-24 ${TH_CLASS}`}>申請者</th>
                {/* 見出しが長いので折り返す (行の whitespace-nowrap を上書きする) */}
                <th className={`w-24 whitespace-normal ${TH_CLASS}`}>支払金額(税込)</th>
                <th className={`w-24 ${TH_CLASS}`}>支払先</th>
                <th className={`w-24 whitespace-normal ${TH_CLASS}`}>最終承認日</th>
                <th className={`w-40 ${TH_CLASS}`}>ファイル名</th>
                <th className={`w-14 ${TH_CLASS}`}>ページ</th>
                <th className={`w-16 ${TH_CLASS}`}>大きさ</th>
                <th className={`w-28 ${TH_CLASS}`}>状態</th>
                <th className={`w-24 ${TH_CLASS}`} />
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const saving = savingNos.has(item.denpyo_no);
                const known = hasFlags(item);
                const disabled = saving || !known || flagDisabledReason !== null;
                return (
                  <tr
                    key={item.denpyo_no}
                    aria-busy={saving}
                    className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${item.exists ? "" : "opacity-60"}`}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">
                      {item.denpyo_no}
                    </td>
                    {/* 物件名は施主名を含むことがある。取り出せなければ空欄 */}
                    <td className="px-3 py-2 font-medium">{dash(item.property_name)}</td>
                    {FLAG_COLUMNS.map((col) => (
                      <td key={col.key} className="px-3 py-2">
                        {known ? (
                          <label
                            className={`flex items-center ${disabled ? "" : "cursor-pointer"}`}
                            title={
                              saving
                                ? "変更しています…"
                                : (flagDisabledReason ?? flagsUpdatedTitle(item))
                            }
                          >
                            <input
                              type="checkbox"
                              // 出すのは /list が返した値そのもの。応答が返るまで変えないので、
                              // 失敗しても元に戻す処理は要らない (そもそも変わっていない)
                              checked={item[col.key] === true}
                              disabled={disabled}
                              // exists=false の行でも変えられる
                              // (404 は記録の有無で決まる。隣のプレビューとは逆)
                              onChange={(e) =>
                                onToggleFlag(item.denpyo_no, col.key, e.target.checked)
                              }
                              aria-label={`${item.denpyo_no} の${col.label}`}
                              className={CHECKBOX_CLASS}
                            />
                          </label>
                        ) : (
                          // フラグに未対応のサーバー・この機能より前のキャッシュ。
                          // 未チェックとして見せると「未入力」の嘘になるので「－」にする
                          <span
                            className="text-slate-400"
                            title="このPCのサーバーはチェックに未対応です (~/tenmatsu-dl/ を更新してください)"
                          >
                            －
                          </span>
                        )}
                      </td>
                    ))}
                    {/* ここから4つは楽楽精算の一覧から読んだ値。古い記録では空欄になる */}
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {dash(item.shinsei_date)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {dash(item.shinseisha)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-slate-600">
                      {dash(item.amount)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {dash(item.payee)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {dash(item.final_approved_at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">{item.file}</td>
                    <td className="px-3 py-2 text-slate-600">{item.pages ?? "－"}</td>
                    <td className="px-3 py-2 text-slate-600">{formatFileSize(item.size)}</td>
                    <td className="px-3 py-2">
                    <span
                        className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${
                          item.exists
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {item.exists ? "取得済み" : "ファイルなし"}
                      </span>
                      {item.completed === true && (
                        // 取得済み (emerald) と混ざらない色にする
                        <span className="ml-1 whitespace-nowrap rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-900">
                          完了
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onPreview(item.denpyo_no)}
                        disabled={!item.exists || !canPreview}
                        title={
                          item.exists
                            ? undefined
                            : "PCの保存先からファイルが消えています。もう一度取得してください"
                        }
                        className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        プレビュー
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
