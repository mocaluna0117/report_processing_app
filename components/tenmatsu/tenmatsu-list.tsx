"use client";

import { useMemo } from "react";
import {
  type ListItem,
  formatFetchedAt,
  formatFileSize,
  hasFlags,
} from "@/lib/tenmatsu/client";
import {
  LIST_FILTERS,
  type ListFilter,
  listCounts,
  visibleListItems,
} from "@/lib/tenmatsu/list-view";

/** 画面から切り替えられる完了フラグ */
export type FlagKey = "budget_entered" | "cloud_stored";

const FLAG_COLUMNS: readonly { key: FlagKey; label: string }[] = [
  { key: "budget_entered", label: "実行予算入力済み" },
  { key: "cloud_stored", label: "クラウド格納済み" },
];

const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

/** 印を最後に変えた日時。列を増やさず title に出す */
const flagsUpdatedTitle = (item: ListItem) =>
  item.flags_updated_at ? `最終更新 ${formatFetchedAt(item.flags_updated_at)}` : "まだ変更していません";

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
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="whitespace-nowrap border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th className="w-32 px-3 py-2">伝票No.</th>
                <th className="px-3 py-2">ファイル名</th>
                {FLAG_COLUMNS.map((col) => (
                  // 細い列に収めるため折り返す (行の whitespace-nowrap を上書きする)
                  <th key={col.key} className="w-20 whitespace-normal px-3 py-2">
                    {col.label}
                  </th>
                ))}
                <th
                  className="w-32 px-3 py-2"
                  title="PC側の記録に足した順の逆に並びます (取得日時での並べ替えではありません)"
                >
                  取得日時
                </th>
                <th className="w-16 px-3 py-2">ページ</th>
                <th className="w-20 px-3 py-2">大きさ</th>
                <th className="w-28 px-3 py-2">状態</th>
                <th className="w-28 px-3 py-2" />
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
                    <td className="px-3 py-2 font-medium">{item.file}</td>
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
                    <td className="px-3 py-2 text-slate-600">{formatFetchedAt(item.at)}</td>
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
      )}
    </>
  );
}
