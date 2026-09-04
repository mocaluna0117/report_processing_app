// 顛末書の一覧の「見せ方」だけを決める純関数。
//
// 画面 (components/tenmatsu/) から切り出してあるのは、この repo の vitest が node 環境で
// DOM を持たないため。一番間違えやすい「絞り込み × 完了の非表示 × 件数の表示」を
// ここに閉じ込めれば、組み合わせを単体テストで固定できる。
import { type HealthPayload, type ListItem, hasFlags, resolveRunLimits } from "@/lib/tenmatsu/client";

/** 一覧の絞り込み。completed は「両方 true」なので、下の2つとは排他になる */
export type ListFilter = "all" | "budget" | "cloud";

export const LIST_FILTERS: readonly { value: ListFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "budget", label: "実行予算が未入力" },
  { value: "cloud", label: "クラウド未格納" },
];

export interface ListViewOptions {
  filter: ListFilter;
  /** 完了した行も出すか (既定は false ＝ やることが残っている行だけ見せる) */
  showCompleted: boolean;
  /**
   * この画面で今チェックを変えた伝票No.。
   * 完了になっても次に一覧を読み直すまでは隠さない
   * (2つ目にチェックを入れた瞬間に行が消えると、押し間違いを戻せないため)。
   */
  keepNos?: ReadonlySet<string>;
}

/** 絞り込みだけを当てる (完了の非表示はまだ当てない) */
function filtered(items: ListItem[], filter: ListFilter): ListItem[] {
  // フラグが分からない行は絞り込みでも落とさない (未入力とも入力済みとも言えないため)
  if (filter === "budget") {
    return items.filter((i) => !hasFlags(i) || i.budget_entered !== true);
  }
  if (filter === "cloud") {
    return items.filter((i) => !hasFlags(i) || i.cloud_stored !== true);
  }
  return items;
}

/**
 * 完了の規則で隠す行か。
 * - フラグが分からない行 (未対応のサーバー・古いキャッシュ) は完了扱いにしない
 * - PDFが消えている行は完了していても隠さない (exists=false を隠さない方針)
 * - この画面で今チェックを変えた行は残す
 */
function hiddenAsCompleted(item: ListItem, options: ListViewOptions): boolean {
  if (options.showCompleted) return false;
  if (!hasFlags(item) || item.completed !== true) return false;
  if (!item.exists) return false;
  return !options.keepNos?.has(item.denpyo_no);
}

/** 画面に出す行。絞り込み → 完了の非表示 の順に当てる */
export function visibleListItems(items: ListItem[], options: ListViewOptions): ListItem[] {
  return filtered(items, options.filter).filter((i) => !hiddenAsCompleted(i, options));
}

export interface ListCounts {
  /** 画面に出ている件数 */
  shown: number;
  /** 完了の規則で隠した件数 */
  hiddenCompleted: number;
  /** 絞り込みで外した件数 */
  hiddenByFilter: number;
  /**
   * PDFが消えている記録の件数。**絞り込みを当てる前の全件から数える。**
   * 絞り込みで見えなくなっていても件数だけは必ず伝えるため
   * (完了の非表示では隠していないので hiddenCompleted には入らない)。
   */
  missingFile: number;
  total: number;
}

/**
 * 件数の内訳。
 * **shown + hiddenCompleted + hiddenByFilter === total が常に成り立つ**ように定義してある。
 * 「完了 N件を非表示中」だけを出すと、絞り込み中は N が必ず0になり
 * (未入力・未格納は完了と排他)、行が消えたのに何も説明されない状態になる。
 */
export function listCounts(items: ListItem[], options: ListViewOptions): ListCounts {
  const pool = filtered(items, options.filter);
  const shown = pool.filter((i) => !hiddenAsCompleted(i, options)).length;
  return {
    shown,
    hiddenCompleted: pool.length - shown,
    hiddenByFilter: items.length - pool.length,
    missingFile: items.filter((i) => !i.exists).length,
    total: items.length,
  };
}

export interface PerRun {
  /** 入力欄に入れる件数 */
  value: number;
  min: number;
  max: number;
  /** サーバーが件数指定に対応しているか。false なら入力欄を出さない */
  fromServer: boolean;
  /** 保存されていた件数が範囲外で丸めたか (理由を一度出すため) */
  clamped: boolean;
}

/**
 * 件数入力欄の値を決める。
 * 保存値 → 整数かつ範囲内か → だめならサーバーの既定値 → だめなら折り込みの既定値。
 *
 * 範囲は server.py の定数なのでPCごとには変わらないが、サーバーを入れ替えると変わり得る。
 * そのため丸めは保存時ではなく**使うとき**に行う。
 */
export function resolvePerRun(
  stored: number | null | undefined,
  health: HealthPayload | null | undefined,
): PerRun {
  const limits = resolveRunLimits(health);
  if (typeof stored !== "number" || !Number.isInteger(stored)) {
    return { ...limits, clamped: false };
  }
  const value = Math.min(limits.max, Math.max(limits.min, stored));
  return { ...limits, value, clamped: value !== stored };
}
