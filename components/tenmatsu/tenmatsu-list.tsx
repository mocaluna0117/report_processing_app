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

const FLAG_COLUMNS: readonly {
  key: FlagKey;
  head: string;
  label: string;
  todo: string;
  done: string;
}[] = [
  // head は枠の見出し、label は読み上げに使う正式名、
  // todo / done はボタンの文字 (見出しに項目名があるので、ボタンは状態だけを書く)
  { key: "budget_entered", head: "実行予算", label: "実行予算入力済み", todo: "未入力", done: "入力済み" },
  { key: "cloud_stored", head: "クラウド", label: "クラウド格納済み", todo: "未格納", done: "格納済み" },
];

/**
 * 完了フラグのボタン。押すと反対の状態に切り替わる (押し間違いはもう一度押して戻す)。
 * 完了は「取得済み」バッジと同じ系統の緑にして、一覧の中で済・未済が一目で分かるようにする。
 */
const FLAG_BUTTON_BASE =
  "rounded-md border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";
const FLAG_BUTTON_TODO = "border-slate-300 bg-white text-slate-500 hover:bg-slate-50";
const FLAG_BUTTON_DONE = "border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-200";

const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 見出しのセル。縦スクロールしても残るように1つずつ sticky にする
 * (背景色は tr ではなくセルに付けないと、下の行が透けて見える)。
 */
const TH_CLASS = "sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-3 py-2";
/**
 * 右端の固定枠 (完了フラグ2つとプレビュー)。楽楽精算のデータ列とは別枠にして、
 * 横にスクロールしても常に見えるようにする。境界は他の罫線より濃くして「別枠」と分かるように。
 * z-30 (見出しの固定枠) > z-20 (通常の見出し) > z-10 (本体の固定枠) は results-table.tsx と同じ。
 * 固定するのは1セルだけ (3セルを right-* で並べると、table-auto では実幅が内容依存でずれる)。
 */
const FRAME_TH_CLASS =
  "sticky right-0 top-0 z-30 border-b border-l-2 border-b-slate-200 border-l-slate-300 bg-slate-50 px-3 py-2";
const FRAME_TD_CLASS =
  "sticky right-0 z-10 border-l-2 border-l-slate-300 bg-white px-3 py-2 group-hover:bg-slate-50";
/** 固定枠の中の並び。見出しと本体で同じ幅を使って縦を揃える (「✓ 入力済み」が収まる幅) */
const FRAME_SLOT_CLASS = "flex w-24 items-center";
const FRAME_BUTTON_SLOT_CLASS = "w-24";

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
          {/* scroll-pt / scroll-pr は Tab移動でセルが固定した見出し・右端の枠の下に潜らないための余白 */}
          <div className="max-h-[60vh] scroll-pt-10 scroll-pr-96 overflow-auto">
            {/* whitespace-nowrap は継承するので、見出しもセルも1つも折り返さない。
                幅は内容に合わせて伸びる (table-auto)。支払先など長い値ははみ出さずに列が広がり、
                表が横にスクロールする */}
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th
                    className={TH_CLASS}
                    title="PC側の記録に足した順の逆に並びます (申請日での並べ替えではありません)"
                  >
                    伝票No.
                  </th>
                  <th className={TH_CLASS}>ファイル名</th>
                  <th className={TH_CLASS}>物件名</th>
                  <th className={TH_CLASS}>申請日</th>
                  <th className={TH_CLASS}>申請者</th>
                  <th className={TH_CLASS}>支払金額(税込)</th>
                  <th className={TH_CLASS}>支払先</th>
                  <th className={TH_CLASS}>最終承認日</th>
                  <th className={`w-14 ${TH_CLASS}`}>ページ</th>
                  <th className={`w-16 ${TH_CLASS}`}>大きさ</th>
                  <th className={TH_CLASS}>状態</th>
                  {/* 右端の固定枠。ボタンの上は空けておく */}
                  <th className={FRAME_TH_CLASS}>
                    <div className="flex items-center gap-2">
                      {FLAG_COLUMNS.map((col) => (
                        <span key={col.key} className={FRAME_SLOT_CLASS} title={col.label}>
                          {col.head}
                        </span>
                      ))}
                      <span className={FRAME_BUTTON_SLOT_CLASS} />
                    </div>
                  </th>
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
                      // group は固定枠のセルにも hover の色を渡すため (sticky のセルは行の背景を継がない)
                      className={`group border-b border-slate-100 last:border-0 hover:bg-slate-50 ${item.exists ? "" : "opacity-60"}`}
                    >
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">
                        {item.denpyo_no}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{item.file}</td>
                      {/* 物件名は施主名を含むことがある。取り出せなければ空欄 */}
                      <td className="px-3 py-2 text-slate-600">{dash(item.property_name)}</td>
                      {/* ここから5つは楽楽精算から読んだ値。古い記録では空欄になる */}
                      <td className="px-3 py-2 text-slate-600">{dash(item.shinsei_date)}</td>
                      <td className="px-3 py-2 text-slate-600">{dash(item.shinseisha)}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{dash(item.amount)}</td>
                      <td className="px-3 py-2 text-slate-600">{dash(item.payee)}</td>
                      <td className="px-3 py-2 text-slate-600">{dash(item.final_approved_at)}</td>
                      <td className="px-3 py-2 text-slate-600">{item.pages ?? "－"}</td>
                      <td className="px-3 py-2 text-slate-600">{formatFileSize(item.size)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            item.exists
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {item.exists ? "取得済み" : "ファイルなし"}
                        </span>
                        {item.completed === true && (
                          // 取得済み (emerald) と混ざらない色にする
                          <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-900">
                            完了
                          </span>
                        )}
                      </td>
                      {/* 右端の固定枠: 完了フラグ2つ + プレビュー */}
                      <td className={FRAME_TD_CLASS}>
                        <div className="flex items-center gap-2">
                          {FLAG_COLUMNS.map((col) => {
                            if (!known) {
                              // フラグに未対応のサーバー・この機能より前のキャッシュ。
                              // 「未入力」と見せると嘘になるので「－」にする
                              return (
                                <span
                                  key={col.key}
                                  className={`${FRAME_SLOT_CLASS} text-slate-400`}
                                  title="このPCのサーバーは完了の印に未対応です (~/tenmatsu-dl/ を更新してください)"
                                >
                                  －
                                </span>
                              );
                            }
                            const done = item[col.key] === true;
                            return (
                              <span key={col.key} className={FRAME_SLOT_CLASS}>
                                <button
                                  type="button"
                                  // 出すのは /list が返した値そのもの。応答が返るまで変えないので、
                                  // 失敗しても元に戻す処理は要らない (そもそも変わっていない)
                                  aria-pressed={done}
                                  aria-label={`${item.denpyo_no} の${col.label}`}
                                  disabled={disabled}
                                  // exists=false の行でも変えられる
                                  // (404 は記録の有無で決まる。隣のプレビューとは逆)
                                  onClick={() => onToggleFlag(item.denpyo_no, col.key, !done)}
                                  title={
                                    saving
                                      ? "変更しています…"
                                      : (flagDisabledReason ??
                                        (done
                                          ? `押すと${col.todo}に戻ります。${flagsUpdatedTitle(item)}`
                                          : `押すと${col.done}にします`))
                                  }
                                  className={`${FLAG_BUTTON_BASE} ${done ? FLAG_BUTTON_DONE : FLAG_BUTTON_TODO} ${disabled ? "" : "cursor-pointer"}`}
                                >
                                  {done ? `✓ ${col.done}` : col.todo}
                                </button>
                              </span>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => onPreview(item.denpyo_no)}
                            disabled={!item.exists || !canPreview}
                            title={
                              item.exists
                                ? undefined
                                : "PCの保存先からファイルが消えています。もう一度取得してください"
                            }
                            className={`${FRAME_BUTTON_SLOT_CLASS} cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50`}
                          >
                            プレビュー
                          </button>
                        </div>
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
