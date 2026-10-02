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
import {
  hasAwaiting,
  missingBadgeTitle,
  pendingBadgeTitle,
  recomposedBadgeTitle,
} from "@/lib/tenmatsu/pending";

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
   * この画面で今チェックを変えた伝票№。
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
  /**
   * 検索欄の文字。空白で区切った語が**すべて**含まれる行だけ残す。
   * 検索している間は完了した行も隠さない (探している書類が完了済みで見つからない、を避ける)。
   */
  query?: string;
}

/**
 * 検索の対象にする項目。種類に無い項目は null なので、種類で分けずに全部見る。
 * 物件名・ファイル名のほか、伝票№・表題・内容・支払先なども探せるようにする。
 */
const SEARCH_FIELDS = [
  "denpyo_no",
  "file",
  "property_name",
  "title",
  "content",
  "senketsu_no",
  "pj",
  "payee",
  "shinseisha",
  "shinsei_date",
  "amount",
  "final_approved_at",
] as const satisfies readonly (keyof ListItem)[];

/**
 * 比べる前にそろえる。全角英数・半角カナの違いと大文字・小文字の違いを無くす
 * (「ＳＥＣＵＲＥＡ」と「securea」、「№」と「No」を同じに扱う)。
 */
const normalizeForSearch = (s: string) => s.normalize("NFKC").toLowerCase();

/** 検索欄の文字を語に分ける。全角の空白も区切りにする (NFKC で半角になる) */
export function searchTerms(query: string | undefined): string[] {
  if (!query) return [];
  return normalizeForSearch(query).split(/\s+/).filter(Boolean);
}

/** その行がすべての語を含むか。語が無ければ常に true */
export function matchesSearch(item: ListItem, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = normalizeForSearch(
    SEARCH_FIELDS.map((field) => item[field] ?? "").join("\n"),
  );
  return terms.every((t) => haystack.includes(t));
}

/** 絞り込みだけを当てる (検索・完了の非表示はまだ当てない) */
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
  // 検索中は完了した行も出す (探している書類は完了済みのことが多い)
  if (searchTerms(options.query).length > 0) return false;
  // 保留中は「あとで添付を足す」作業が残っている。サーバーの不具合で completed が
  // 付いていても隠さない（隠すと、やることがあるのに気づけない）
  if (isPending(item)) return false;
  if (!hasFlags(item, options.flagKeys ?? TENMATSU_FLAG_KEYS) || item.completed !== true) {
    return false;
  }
  if (!item.exists) return false;
  return !options.keepNos?.has(item.denpyo_no);
}

/** 絞り込みのあとに検索を当てる */
function searched(pool: ListItem[], options: ListViewOptions): ListItem[] {
  const terms = searchTerms(options.query);
  if (terms.length === 0) return pool;
  return pool.filter((i) => matchesSearch(i, terms));
}

/** 画面に出す行。絞り込み → 検索 → 完了の非表示 の順に当てる */
export function visibleListItems(items: ListItem[], options: ListViewOptions): ListItem[] {
  return searched(filtered(items, options), options).filter(
    (i) => !hiddenAsCompleted(i, options),
  );
}

/**
 * 一覧の並べ替え。default は**サーバーが返した順**
 * (PC側の記録に足した順の逆。取得日時の並べ替えではない)。
 * 押せる見出しは「伝票№」と「ファイル名」。
 */
export type ListSort = "default" | "file-asc" | "file-desc" | "no-asc" | "no-desc";

/** 並べ替えられる列 */
export type SortColumn = "file" | "no";

/** いまその列で並べているか (昇順・降順のどちらか) */
export function sortColumnOf(sort: ListSort): SortColumn | null {
  if (sort === "default") return null;
  return sort.startsWith("no-") ? "no" : "file";
}

/**
 * 見出しを押したときの次の並び。
 * 同じ列を押すたびに 既定 → 昇順 → 降順 → 既定 と回り、別の列を押すとその列の昇順から始める。
 */
export function nextListSort(sort: ListSort, column: SortColumn = "file"): ListSort {
  const asc: ListSort = column === "no" ? "no-asc" : "file-asc";
  const desc: ListSort = column === "no" ? "no-desc" : "file-desc";
  if (sort === asc) return desc;
  if (sort === desc) return "default";
  return asc;
}

/**
 * ファイル名・伝票№の比較。**数字は数値として比べる。**
 * 名前が「顛末書№1476.pdf」の形なので、素の文字列比較だと
 * 1476 < 9001 < 999 の順になってしまう (先頭の文字から1桁ずつ比べるため)。
 */
const fileCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * ファイル名か伝票№で並べ替える。元の配列は変えない。
 * default はサーバーの順をそのまま返す (並べ替えない、が「元に戻せる」ことになる)。
 */
export function sortListItems(items: ListItem[], sort: ListSort): ListItem[] {
  const column = sortColumnOf(sort);
  if (column === null) return items;
  const sign = sort.endsWith("-asc") ? 1 : -1;
  const keyOf = column === "no" ? (item: ListItem) => item.denpyo_no : (item: ListItem) => item.file;
  // sort は安定なので、値が同じ行はサーバーの順のまま並ぶ
  return [...items].sort((a, b) => sign * fileCollator.compare(keyOf(a), keyOf(b)));
}

export interface ListCounts {
  /** 画面に出ている件数 */
  shown: number;
  /** 完了の規則で隠した件数 */
  hiddenCompleted: number;
  /** 絞り込みで外した件数 */
  hiddenByFilter: number;
  /** 絞り込みのあと、検索で外した件数 */
  hiddenBySearch: number;
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
 * **shown + hiddenCompleted + hiddenByFilter + hiddenBySearch === total が常に成り立つ**
 * ように定義してある。
 * 「完了 N件を非表示中」だけを出すと、絞り込み中は N が必ず0になり
 * (未入力・未格納は完了と排他)、行が消えたのに何も説明されない状態になる。
 */
export function listCounts(items: ListItem[], options: ListViewOptions): ListCounts {
  const pool = filtered(items, options);
  const hits = searched(pool, options);
  const shown = hits.filter((i) => !hiddenAsCompleted(i, options)).length;
  return {
    shown,
    hiddenCompleted: hits.length - shown,
    hiddenByFilter: items.length - pool.length,
    hiddenBySearch: pool.length - hits.length,
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
  | "recomposed"
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

/**
 * 1行に出す状態のバッジ。
 * marks は「格納済みの印」のような言い方（差し替えで外れる印の名前）。
 */
export function statusBadges(item: ListItem, marks = "完了の印"): StatusBadge[] {
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
  // 確定したあとに書類を差し替えた行。中身が変わって印が外れているので、その理由も出す
  if (item.recomposed_at) {
    badges.push({
      key: "recomposed",
      text: "差し替え済み",
      title: recomposedBadgeTitle(item.recomposed_at, marks),
    });
  }
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
