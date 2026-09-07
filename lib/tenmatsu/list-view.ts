// 顛末書の一覧の「見せ方」だけを決める純関数。
//
// 画面 (components/tenmatsu/) から切り出してあるのは、この repo の vitest が node 環境で
// DOM を持たないため。一番間違えやすい「絞り込み × 完了の非表示 × 件数の表示」を
// ここに閉じ込めれば、組み合わせを単体テストで固定できる。
import {
  type FlagKey,
  type HealthPayload,
  type ListItem,
  TENMATSU_FLAG_KEYS,
  hasFlags,
  isPending,
  resolveRunLimits,
} from "@/lib/tenmatsu/client";
import { hasAwaiting, missingBadgeTitle, pendingBadgeTitle } from "@/lib/tenmatsu/pending";

/**
 * 一覧の絞り込み。completed は「全部 true」なので、フラグの絞り込みとは排他になる。
 * **全種類の値を並べた閉じた合併**にしておく (綴り違いを型で捕まえる)。
 */
export type ListFilter = "all" | "budget" | "cloud";

/** 絞り込み1つ分。flagKey が null なら「すべて」 */
export interface ListFilterDef {
  value: ListFilter;
  label: string;
  flagKey: FlagKey | null;
}

/** 顛末書の絞り込み (種類を渡さない呼び出しの既定) */
export const LIST_FILTERS: readonly ListFilterDef[] = [
  { value: "all", label: "すべて", flagKey: null },
  { value: "budget", label: "実行予算が未入力", flagKey: "budget_entered" },
  { value: "cloud", label: "クラウド未格納", flagKey: "cloud_stored" },
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
  /**
   * 絞り込みの定義と、この種類が使うフラグ。省略時は顛末書。
   * 画面からは必ず種類の値を渡す (絞り込みと完了の非表示が別の種類を見ないよう
   * 1つのオブジェクトにまとめてある)。
   */
  filters?: readonly ListFilterDef[];
  flagKeys?: readonly FlagKey[];
}

/** 絞り込みだけを当てる (完了の非表示はまだ当てない) */
function filtered(items: ListItem[], options: ListViewOptions): ListItem[] {
  const defs = options.filters ?? LIST_FILTERS;
  const flagKeys = options.flagKeys ?? TENMATSU_FLAG_KEYS;
  const def = defs.find((f) => f.value === options.filter);
  // その種類に無い絞り込みが残っていても落とさない (「すべて」と同じ扱い)
  if (!def?.flagKey) return items;
  const key = def.flagKey;
  // フラグが分からない行は絞り込みでも落とさない (未入力とも入力済みとも言えないため)
  return items.filter((i) => !hasFlags(i, flagKeys) || i[key] !== true);
}

/**
 * 完了の規則で隠す行か。
 * - フラグが分からない行 (未対応のサーバー・古いキャッシュ) は完了扱いにしない
 * - PDFが消えている行は完了していても隠さない (exists=false を隠さない方針)
 * - この画面で今チェックを変えた行は残す
 */
function hiddenAsCompleted(item: ListItem, options: ListViewOptions): boolean {
  if (options.showCompleted) return false;
  // 保留中は「あとで添付を足す」作業が残っている。サーバーの不具合で completed が
  // 付いていても隠さない（隠すと、やることがあるのに気づけない）
  if (isPending(item)) return false;
  if (!hasFlags(item, options.flagKeys ?? TENMATSU_FLAG_KEYS) || item.completed !== true) {
    return false;
  }
  if (!item.exists) return false;
  return !options.keepNos?.has(item.denpyo_no);
}

/** 画面に出す行。絞り込み → 完了の非表示 の順に当てる */
export function visibleListItems(items: ListItem[], options: ListViewOptions): ListItem[] {
  return filtered(items, options).filter((i) => !hiddenAsCompleted(i, options));
}

/**
 * 一覧の並べ替え。default は**サーバーが返した順**
 * (PC側の記録に足した順の逆。取得日時の並べ替えではない)。
 */
export type ListSort = "default" | "file-asc" | "file-desc";

/** 見出しを押すたびに 既定 → 昇順 → 降順 → 既定 と回る */
export function nextListSort(sort: ListSort): ListSort {
  if (sort === "default") return "file-asc";
  if (sort === "file-asc") return "file-desc";
  return "default";
}

/**
 * ファイル名の比較。**数字は数値として比べる。**
 * 名前が「顛末書No.1476.pdf」の形なので、素の文字列比較だと
 * 1476 < 9001 < 999 の順になってしまう (先頭の文字から1桁ずつ比べるため)。
 */
const fileCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * ファイル名で並べ替える。元の配列は変えない。
 * default はサーバーの順をそのまま返す (並べ替えない、が「元に戻せる」ことになる)。
 */
export function sortListItems(items: ListItem[], sort: ListSort): ListItem[] {
  if (sort === "default") return items;
  const sign = sort === "file-asc" ? 1 : -1;
  // sort は安定なので、ファイル名が同じ行はサーバーの順のまま並ぶ
  return [...items].sort((a, b) => sign * fileCollator.compare(a.file, b.file));
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
  /**
   * 添付を結合できず保留中の件数。**missingFile と同じく絞り込みの前の全件から数える。**
   * 絞り込みで見えなくなっていても、やることが残っていることは必ず伝える。
   */
  pending: number;
  /** そのうち、あとから書類を入れるのを待っている件数（pending に含まれる） */
  awaiting: number;
  total: number;
}

/**
 * 件数の内訳。
 * **shown + hiddenCompleted + hiddenByFilter === total が常に成り立つ**ように定義してある。
 * 「完了 N件を非表示中」だけを出すと、絞り込み中は N が必ず0になり
 * (未入力・未格納は完了と排他)、行が消えたのに何も説明されない状態になる。
 */
export function listCounts(items: ListItem[], options: ListViewOptions): ListCounts {
  const pool = filtered(items, options);
  const shown = pool.filter((i) => !hiddenAsCompleted(i, options)).length;
  return {
    shown,
    hiddenCompleted: pool.length - shown,
    hiddenByFilter: items.length - pool.length,
    missingFile: items.filter((i) => !i.exists).length,
    pending: items.filter(isPending).length,
    awaiting: items.filter(
      (i) => isPending(i) && hasAwaiting(i.missing_attachments ?? []),
    ).length,
    total: items.length,
  };
}

/**
 * 行の「状態」欄に出す印。
 * 何を出すかはコンポーネントの外で決める（node 環境の vitest で確かめられるように）。
 */
export type StatusBadgeKey =
  | "pending"
  | "awaiting"
  | "fetched"
  | "missingFile"
  | "completed"
  | "skipped"
  | "missingAttachments";

export interface StatusBadge {
  key: StatusBadgeKey;
  text: string;
  title?: string;
}

export function statusBadges(item: ListItem): StatusBadge[] {
  const badges: StatusBadge[] = [];
  const missing = item.missing_attachments ?? [];
  if (isPending(item)) {
    // 保留中は正式なフォルダにまだ入っていないので「取得済み」とは言わない。
    // ★あとから書類を入れる種類（捺印決裁書）は「結合できなかった」のではないので、
    //   「アップロード待ち」と言い分ける
    badges.push(
      hasAwaiting(missing)
        ? { key: "awaiting", text: "アップロード待ち", title: pendingBadgeTitle(missing) }
        : { key: "pending", text: "保留", title: pendingBadgeTitle(missing) },
    );
    if (!item.exists) {
      badges.push({ key: "missingFile", text: "ファイルなし" });
    }
  } else {
    badges.push(
      item.exists
        ? { key: "fetched", text: "取得済み" }
        : { key: "missingFile", text: "ファイルなし" },
    );
  }
  if (item.completed === true) badges.push({ key: "completed", text: "完了" });
  if (item.skipped_attachments && item.skipped_attachments.length > 0) {
    badges.push({
      key: "skipped",
      text: "動画は未結合",
      title: `PDFに入っていません: ${item.skipped_attachments.join(", ")}`,
    });
  }
  // 欠けたまま確定した行。保留中はもう「保留」で伝えているので出さない
  if (!isPending(item) && missing.length > 0) {
    badges.push({
      key: "missingAttachments",
      text: "添付が欠けています",
      title: missingBadgeTitle(missing),
    });
  }
  return badges;
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
