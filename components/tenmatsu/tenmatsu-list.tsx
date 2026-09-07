"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type FlagKey,
  type ListItem,
  formatFileSize,
  hasFlags,
  isPending,
} from "@/lib/tenmatsu/client";
import {
  type ListFilter,
  type ListSort,
  listCounts,
  nextListSort,
  sortListItems,
  visibleListItems,
  type StatusBadgeKey,
  statusBadges,
} from "@/lib/tenmatsu/list-view";
import type { DocKind } from "@/lib/tenmatsu/kinds";
import { pendingBadgeTitle, recomposeDisabledReason } from "@/lib/tenmatsu/pending";


/**
 * 完了フラグのボタン。押すと反対の状態に切り替わる (押し間違いはもう一度押して戻す)。
 * 完了は「取得済み」バッジと同じ系統の緑にして、一覧の中で済・未済が一目で分かるようにする。
 */
const FLAG_BUTTON_BASE =
  "rounded-md border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";
const FLAG_BUTTON_TODO = "border-slate-300 bg-white text-slate-500 hover:bg-slate-50";
const FLAG_BUTTON_DONE = "border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-200";
/** 保留中の行に出す「添付を足す」。印とは別の色にして、やることが残っていると分かるようにする */
const RESOLVE_BUTTON_CLASS =
  "border-orange-300 bg-orange-50 text-orange-900 hover:bg-orange-100";

/** 状態の印の色。何を出すかは list-view.ts の statusBadges が決める */
const BADGE_CLASS: Record<StatusBadgeKey, string> = {
  pending: "bg-orange-100 text-orange-900",
  // アップロード待ちは「これから入れる」ので、警告色の保留とは分ける
  awaiting: "bg-sky-100 text-sky-900",
  recomposed: "bg-violet-100 text-violet-900",
  fetched: "bg-emerald-100 text-emerald-800",
  missingFile: "bg-slate-100 text-slate-500",
  // 取得済み (emerald) と混ざらない色にする
  completed: "bg-blue-100 text-blue-900",
  skipped: "bg-amber-100 text-amber-900",
  missingAttachments: "bg-amber-100 text-amber-900",
};

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
const SLOT_BUTTON_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
/**
 * 左端の固定列 (伝票No. と ファイル名)。横にスクロールしても「どの伝票の行か」が分かるようにする。
 * 2列目の left は1列目の実幅 (内容依存) を測って inline style で入れる。
 * 2列目の右の境界は右端の枠と同じ濃さにして、ここまでが固定と分かるように。
 */
const LEFT_TH_CLASS = "sticky top-0 z-30 border-b border-slate-200 bg-slate-50 px-3 py-2";
const LEFT_TD_CLASS = "sticky z-10 bg-white px-3 py-2 group-hover:bg-slate-50";
const LEFT_EDGE_CLASS = "border-r-2 border-r-slate-300";

/** ファイル名の見出しに出す印と説明 (押すたびに 既定 → 昇順 → 降順 と回る) */
const SORT_MARK: Record<ListSort, string> = {
  default: "↕",
  "file-asc": "↑",
  "file-desc": "↓",
};
const SORT_TITLE: Record<ListSort, string> = {
  default: "押すとファイル名の昇順に並べ替えます (数字は数の大きさで比べます)",
  "file-asc": "ファイル名の昇順です。押すと降順にします",
  "file-desc": "ファイル名の降順です。押すと元の順 (取得した順の逆) に戻します",
};

/** 空欄の表示。値が無いことを黙って隠さない */
const dash = (value: string | null | undefined) => (value ? value : "－");

/** データ列のセル。右寄せは金額だけ (class 文字列は種類で変えない) */
const DATA_TD_CLASS = {
  left: "px-3 py-2 text-slate-600",
  right: "px-3 py-2 text-right text-slate-600",
} as const;

/** 印を最後に変えた日時。列を増やさず title に出す */
const flagsUpdatedTitle = (item: ListItem) =>
  item.flags_updated_at ? `最終更新 ${item.flags_updated_at}` : "まだ変更していません";

/**
 * 取得済み一覧の表と、その見せ方の操作。
 * 絞り込みと完了の非表示は lib/tenmatsu/list-view.ts の純関数に任せる
 * (この repo の vitest は node 環境なので、判定はコンポーネントの外に出して単体テストする)。
 */
export function TenmatsuList({
  kind,
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
  resolveDisabledReason,
  onResolvePending,
  onRecompose,
}: {
  /** 書類の種類 (列・完了の印・絞り込み・文言をここから引く) */
  kind: DocKind;
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
  /** 「添付を足す」を押せない理由。null なら押せる */
  resolveDisabledReason: string | null;
  /** 確定した行の書類を差し替える (捺印決裁書だけ。押せる行は upload_slots で決まる) */
  onRecompose?: (no: string) => void;
  onResolvePending: (no: string) => void;
}) {
  const view = useMemo(
    () => ({
      filter,
      showCompleted,
      keepNos: recentNos,
      filters: kind.listFilters,
      flagKeys: kind.flagKeys,
    }),
    [filter, showCompleted, recentNos, kind],
  );
  // 並べ替えはこの表の中だけの話なので、ここで持つ (絞り込みと同じく保存しない)
  const [sort, setSort] = useState<ListSort>("default");
  const visible = useMemo(
    () => sortListItems(visibleListItems(items, view), sort),
    [items, view, sort],
  );
  const counts = useMemo(() => listCounts(items, view), [items, view]);

  // 左端の固定列の幅。table-auto では列幅が内容で決まるので、描いた後に測る。
  // 伝票No. の幅が2列目の left、2列分の幅が scroll-padding-left になる
  const noHeadRef = useRef<HTMLTableCellElement>(null);
  const fileHeadRef = useRef<HTMLTableCellElement>(null);
  const [leftWidths, setLeftWidths] = useState({ no: 0, file: 0 });
  const hasTable = visible.length > 0;
  useLayoutEffect(() => {
    const noEl = noHeadRef.current;
    const fileEl = fileHeadRef.current;
    if (!noEl || !fileEl) return;
    const measure = () => {
      // offsetWidth は整数に丸めるので、境界に隙間が出ないよう小数のまま使う
      const no = noEl.getBoundingClientRect().width;
      const file = fileEl.getBoundingClientRect().width;
      setLeftWidths((prev) => (prev.no === no && prev.file === file ? prev : { no, file }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(noEl);
    ro.observe(fileEl);
    return () => ro.disconnect();
  }, [hasTable]);

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label
          className="flex cursor-pointer items-center gap-1.5 text-sm"
          title={kind.text.completedHint}
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
              const next = kind.listFilters.find((f) => f.value === e.target.value);
              if (next) onFilterChange(next.value);
            }}
            className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {kind.listFilters.map((f) => (
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
          {counts.pending - counts.awaiting > 0 && (
            // 添付を足すという作業が残っている行。同上
            <span className="ml-1 text-orange-800">
              添付を結合できず保留中の{kind.label}が {counts.pending - counts.awaiting}件あります
            </span>
          )}
          {counts.awaiting > 0 && (
            // 書類を入れれば確定できる行。これから入れるので色を分ける
            <span className="ml-1 text-sky-800">
              アップロード待ちの{kind.label}が {counts.awaiting}件あります
            </span>
          )}
        </p>
      )}

      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">まだ取得した{kind.label}はありません。</p>
      ) : visible.length === 0 ? (
        // 完了を既定で隠すので、作業が全部済んでいると表が空になる。
        // ここで「まだ取得した◯◯はありません」と出すと嘘になる
        <p className="mt-2 text-sm text-slate-600">
          表示できる行がありません (全 {counts.total}件)。
          {counts.hiddenCompleted > 0 && "「完了したものも表示」で完了した分を出せます。"}
          {counts.hiddenByFilter > 0 && "絞り込みを「すべて」に戻すと全件出ます。"}
        </p>
      ) : (
        // 枠線は外側に持たせ、スクロールするのは表だけにする。
        // 縦もこの中でスクロールさせて、見出しの sticky が枠の中に残るようにする
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          {/* scroll-pt / scroll-pr / scroll-padding-left は Tab移動でセルが固定した見出し・左右の固定列の下に潜らないための余白 */}
          <div
            className="max-h-[75vh] scroll-pt-10 scroll-pr-96 overflow-auto"
            style={{ scrollPaddingLeft: leftWidths.no + leftWidths.file }}
          >
            {/* whitespace-nowrap は継承するので、見出しもセルも1つも折り返さない。
                幅は内容に合わせて伸びる (table-auto)。支払先など長い値ははみ出さずに列が広がり、
                表が横にスクロールする */}
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th
                    ref={noHeadRef}
                    className={`left-0 ${LEFT_TH_CLASS}`}
                    title={
                      sort === "default"
                        ? "PC側の記録に足した順の逆に並びます (申請日での並べ替えではありません)"
                        : "いまはファイル名で並べ替えています"
                    }
                  >
                    伝票No.
                  </th>
                  <th
                    ref={fileHeadRef}
                    // aria-sort は「今どう並んでいるか」を読み上げに伝えるためのもの
                    aria-sort={
                      sort === "file-asc"
                        ? "ascending"
                        : sort === "file-desc"
                          ? "descending"
                          : "none"
                    }
                    className={`${LEFT_TH_CLASS} ${LEFT_EDGE_CLASS}`}
                    style={{ left: leftWidths.no }}
                  >
                    <button
                      type="button"
                      onClick={() => setSort(nextListSort(sort))}
                      title={SORT_TITLE[sort]}
                      className="flex cursor-pointer items-center gap-1 font-medium text-slate-500 hover:text-slate-900"
                    >
                      ファイル名
                      {/* 幅を固定する。ここが伸び縮みすると ResizeObserver 経由で
                          左固定列の left と scroll-padding-left が動いてガタつく */}
                      <span
                        aria-hidden
                        className={`inline-block w-3 text-center ${
                          sort === "default" ? "text-slate-300" : ""
                        }`}
                      >
                        {SORT_MARK[sort]}
                      </span>
                    </button>
                  </th>
                  {kind.dataColumns.map((col) => (
                    <th key={col.field} className={TH_CLASS}>
                      {col.head}
                    </th>
                  ))}
                  <th className={`w-14 ${TH_CLASS}`}>ページ</th>
                  <th className={`w-16 ${TH_CLASS}`}>大きさ</th>
                  <th className={TH_CLASS}>状態</th>
                  {/* 右端の固定枠。ボタンの上は空けておく */}
                  <th className={FRAME_TH_CLASS}>
                    <div className="flex items-center gap-2">
                      {kind.flagColumns.map((col) => (
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
                  const known = hasFlags(item, kind.flagKeys);
                  const disabled = saving || !known || flagDisabledReason !== null;
                  return (
                    <tr
                      key={item.denpyo_no}
                      aria-busy={saving}
                      // group は固定枠のセルにも hover の色を渡すため (sticky のセルは行の背景を継がない)
                      className={`group border-b border-slate-100 last:border-0 hover:bg-slate-50 ${item.exists ? "" : "opacity-60"}`}
                    >
                      <td className={`left-0 font-mono text-xs text-slate-600 ${LEFT_TD_CLASS}`}>
                        {item.denpyo_no}
                      </td>
                      <td
                        className={`text-slate-600 ${LEFT_TD_CLASS} ${LEFT_EDGE_CLASS}`}
                        style={{ left: leftWidths.no }}
                      >
                        {item.file}
                      </td>
                      {/* 楽楽精算から読んだ値。古い記録では空欄になる。
                          物件名は施主名を含むことがある (取り出せなければ空欄) */}
                      {kind.dataColumns.map((col) => (
                        <td key={col.field} className={DATA_TD_CLASS[col.align ?? "left"]}>
                          {dash(item[col.field])}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-slate-600">{item.pages ?? "－"}</td>
                      <td className="px-3 py-2 text-slate-600">{formatFileSize(item.size)}</td>
                      <td className="px-3 py-2">
                        {/* 何を出すかは list-view.ts の statusBadges が決める（単体テストのため） */}
                        {statusBadges(item, kind.text.flagMarks).map((badge, i) => (
                          <span
                            key={badge.key}
                            title={badge.title}
                            className={`${i === 0 ? "" : "ml-1 "}rounded px-1.5 py-0.5 text-xs ${
                              BADGE_CLASS[badge.key]
                            }`}
                          >
                            {badge.text}
                          </span>
                        ))}
                      </td>
                      {/* 右端の固定枠: 完了フラグ2つ + プレビュー */}
                      <td className={FRAME_TD_CLASS}>
                        <div className="flex items-center gap-2">
                          {isPending(item) ? (
                            // 保留中は印を付けられない (サーバーが 409)。
                            // 印の場所に「次にやること」を出す。
                            // 幅は印のスロット (w-24 = 6rem) と gap-2 (0.5rem) の合計に
                            // 合わせて、見出しや他の行とずれないようにする
                            <span
                              className="flex items-center"
                              style={{
                                width: `calc(${kind.flagColumns.length} * 6rem + ${
                                  kind.flagColumns.length - 1
                                } * 0.5rem)`,
                              }}
                            >
                              <button
                                type="button"
                                aria-label={`${item.denpyo_no} の${kind.text.resolveButton}`}
                                disabled={resolveDisabledReason !== null}
                                title={
                                  resolveDisabledReason ??
                                  pendingBadgeTitle(item.missing_attachments ?? [])
                                }
                                onClick={() => onResolvePending(item.denpyo_no)}
                                className={`${FLAG_BUTTON_BASE} ${RESOLVE_BUTTON_CLASS} ${
                                  resolveDisabledReason === null ? "cursor-pointer" : ""
                                }`}
                              >
                                {kind.text.resolveButton}
                              </button>
                            </span>
                          ) : (
                            kind.flagColumns.map((col) => {
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
                            })
                          )}
                          {/* プレビューと「差し替え」は同じ幅の中に縦に積む
                              (固定枠は1セルなので、横に増やすと見出しとずれる) */}
                          <span className={`flex flex-col gap-1 ${FRAME_BUTTON_SLOT_CLASS}`}>
                            <button
                              type="button"
                              onClick={() => onPreview(item.denpyo_no)}
                              disabled={!item.exists || !canPreview}
                              title={
                                !item.exists
                                  ? "PCの保存先からファイルが消えています。もう一度取得してください"
                                  : isPending(item)
                                    ? "保留中のPDF (本体と結合できた添付) を表示します"
                                    : undefined
                              }
                              className={`${SLOT_BUTTON_CLASS} ${item.exists && canPreview ? "cursor-pointer" : ""}`}
                            >
                              プレビュー
                            </button>
                            {kind.canRecompose && !isPending(item) && onRecompose && (
                              <button
                                type="button"
                                aria-label={`${item.denpyo_no} の${kind.text.recomposeButton}`}
                                onClick={() => onRecompose(item.denpyo_no)}
                                disabled={
                                  !canPreview ||
                                  recomposeDisabledReason(item, resolveDisabledReason) !== null
                                }
                                title={
                                  recomposeDisabledReason(item, resolveDisabledReason) ??
                                  "アップロードした書類を入れ替えて組み直します" +
                                    `(${kind.text.flagMarks}は外れます)`
                                }
                                className={`${SLOT_BUTTON_CLASS} ${
                                  canPreview &&
                                  recomposeDisabledReason(item, resolveDisabledReason) === null
                                    ? "cursor-pointer"
                                    : ""
                                }`}
                              >
                                {kind.text.recomposeButton}
                              </button>
                            )}
                          </span>
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
