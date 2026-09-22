/**
 * 「学習した書き方」を2台のあいだで突き合わせる規則。純関数のみ。
 *
 * ★中身は**伏せ字済みの本文だけ**（lib/summarize/examples.ts の約束をそのまま引き継ぐ）。
 *   共有フォルダーに置くものの中で、いちばん個人情報の度合いが低い。
 * ★突き合わせは既にある mergeExamples（同じ id は updatedAt の新しい方）に、
 *   **消した印**を足したもの。印が無いと「消したのにファイルから戻ってくる」が起きる。
 * ★印より新しい updatedAt で学習し直せば復活する（消したあとに直して覚え直せる）。
 */
import {
  EXAMPLES_STORE_MAX,
  type InquiryExample,
  isInquiryExampleLike,
  mergeExamples,
} from "@/lib/summarize/examples";

/** 消した印を置いておく数の上限（共有ファイルが際限なく伸びないように） */
export const EXAMPLES_DELETED_MAX = EXAMPLES_STORE_MAX * 2;

export interface SharedExamples {
  items: InquiryExample[];
  /** 消した手本の id → 消した時刻 */
  deleted: Record<string, number>;
}

export const emptySharedExamples = (): SharedExamples => ({ items: [], deleted: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * ファイルの中身を読む。
 * ★まるごと形が違えば null（＝読めないファイルとして止める）。
 *   1件だけ形が違う手本は落として、ほかは活かす。
 */
export function pickSharedExamples(v: unknown): SharedExamples | null {
  if (!isRecord(v)) return null;
  const items = Array.isArray(v.items) ? v.items.filter(isInquiryExampleLike) : [];
  const deleted: Record<string, number> = {};
  if (isRecord(v.deleted)) {
    for (const [id, at] of Object.entries(v.deleted)) {
      if (typeof at === "number" && Number.isFinite(at)) deleted[id] = at;
    }
  }
  return { items, deleted };
}

/** 消した印を重ねる（id ごとに新しい方。多すぎたら古い順に落とす） */
function mergeDeleted(
  a: Record<string, number>,
  b: Record<string, number>,
  max = EXAMPLES_DELETED_MAX,
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [id, at] of Object.entries(b)) {
    merged[id] = Math.max(merged[id] ?? 0, at);
  }
  const ids = Object.keys(merged);
  if (ids.length <= max) return merged;
  const keep = ids.sort((x, y) => merged[y] - merged[x] || (x < y ? -1 : 1)).slice(0, max);
  const out: Record<string, number> = {};
  for (const id of keep.sort()) out[id] = merged[id];
  return out;
}

/**
 * 2つの束を突き合わせる（可換・冪等）。
 * 消した印と同じか古い手本は落とす（印より新しく学習し直したものは残る）。
 */
export function mergeSharedExamples(
  a: SharedExamples,
  b: SharedExamples,
  max = EXAMPLES_STORE_MAX,
): SharedExamples {
  const deleted = mergeDeleted(a.deleted, b.deleted);
  const items = mergeExamples(a.items, b.items, max).filter((item) => {
    const at = deleted[item.id];
    return at === undefined || item.updatedAt > at;
  });
  return { items, deleted };
}

/** この端末の一覧と消した印から、共有に載せる形を作る */
export function toSharedExamples(
  items: readonly InquiryExample[],
  deleted: Record<string, number>,
): SharedExamples {
  return { items: [...items], deleted: { ...deleted } };
}
