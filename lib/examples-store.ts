"use client";

// 「学習した書き方」の保存 (IndexedDB の meta ストア)。
// 伏せ字済みの本文だけを置き、サーバーへは要約のたびに手本として送る。
// 設定扱いなので「保存データを消去」「受付一覧を消去」では消えず、専用のボタンで消す。
//
// 定期点検 (不具合項目 → 点検内容) とアフターメンテナンス (受付メモ → アフター受付内容) は
// 入力の形もプロンプトも違うので、手本の一覧を別々に持つ。
import {
  type SharedExamples,
  mergeSharedExamples,
  withDeletedMark,
} from "@/lib/shared/examples";
import {
  type InquiryExample,
  isInquiryExampleLike,
  mergeExamples,
  upsertExample,
} from "@/lib/summarize/examples";
import {
  META_INQUIRY_EXAMPLES,
  META_INSPECTION_EXAMPLES,
  STORE_META,
  deleteMeta,
  request,
  sharedExamplesDeletedKey,
  withStore,
} from "@/lib/storage";

/** どちらの画面の手本か */
export type ExampleKind = "inquiry" | "inspection";

const keyOf = (kind: ExampleKind) =>
  kind === "inquiry" ? META_INQUIRY_EXAMPLES : META_INSPECTION_EXAMPLES;

/**
 * この端末で消した手本の印（id → 消した時刻）を置くキー。
 * ★共有フォルダーを使うときに要る: 印が無いと、相手のファイルにまだ残っている手本が
 *   次の同期で戻ってきてしまう（消したのに復活する）。
 * ★共有フォルダーを使っていなくても押しておく（あとからつないでも辻褄が合うように）。
 */
const deletedKeyOf = (kind: ExampleKind) => sharedExamplesDeletedKey(kind);

const valid = (raw: unknown): InquiryExample[] =>
  Array.isArray(raw) ? raw.filter(isInquiryExampleLike) : [];

const validDeleted = (raw: unknown): Record<string, number> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
  }
  return out;
};

export async function loadExamples(kind: ExampleKind): Promise<InquiryExample[]> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(keyOf(kind))));
  return valid(raw);
}

/** この端末で消した手本の印 */
export async function loadDeletedExampleMarks(kind: ExampleKind): Promise<Record<string, number>> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(deletedKeyOf(kind))));
  return validDeleted(raw);
}

/** 共有フォルダーに載せる形（手本＋消した印）でこの端末の分を読む */
export async function loadSharedExamples(kind: ExampleKind): Promise<SharedExamples> {
  const [items, deleted] = await Promise.all([loadExamples(kind), loadDeletedExampleMarks(kind)]);
  return { items, deleted };
}

/**
 * 読み込み → 更新 → 書き込みを1トランザクションで行う。
 * 「配列をまるごと保存」にすると最後の1件を消せなくなるため、操作ごとに読み直す。
 *
 * ★手本と「消した印」は**同じトランザクション**で書く。別々に書くと、途中で失敗したときに
 *   「消えているのに印が無い」（次の同期で戻ってくる）状態が残る。
 */
async function updateShared(
  kind: ExampleKind,
  fn: (current: SharedExamples) => SharedExamples,
): Promise<SharedExamples> {
  const key = keyOf(kind);
  const deletedKey = deletedKeyOf(kind);
  let next: SharedExamples = { items: [], deleted: {} };
  await withStore(STORE_META, "readwrite", async (store) => {
    const [items, deleted] = await Promise.all([
      request(store.get(key)),
      request(store.get(deletedKey)),
    ]);
    next = fn({ items: valid(items), deleted: validDeleted(deleted) });
    if (next.items.length === 0) store.delete(key);
    else store.put(next.items, key);
    if (Object.keys(next.deleted).length === 0) store.delete(deletedKey);
    else store.put(next.deleted, deletedKey);
  });
  return next;
}

const updateExamples = async (
  kind: ExampleKind,
  fn: (current: InquiryExample[]) => InquiryExample[],
): Promise<InquiryExample[]> =>
  (await updateShared(kind, (current) => ({ ...current, items: fn(current.items) }))).items;

/** 1件を学習する / 学習し直す */
export function upsertStoredExample(
  kind: ExampleKind,
  example: InquiryExample,
): Promise<InquiryExample[]> {
  return updateExamples(kind, (current) => upsertExample(current, example));
}

/**
 * 1件の学習を消す。
 * ★消した印も一緒に押す（共有フォルダーを使っているとき、相手からも消えるようにするため）。
 */
export function deleteStoredExample(
  kind: ExampleKind,
  id: string,
  now: number = Date.now(),
): Promise<InquiryExample[]> {
  return updateShared(kind, (current) => ({
    items: current.items.filter((e) => e.id !== id),
    deleted: withDeletedMark(current.deleted, [id], now),
  })).then((next) => next.items);
}

/** 書き出したJSONを取り込む (他の端末から移すとき。同じ id は新しい方を採る) */
export function mergeStoredExamples(
  kind: ExampleKind,
  incoming: InquiryExample[],
): Promise<InquiryExample[]> {
  return updateExamples(kind, (current) => mergeExamples(current, incoming));
}

/**
 * 共有フォルダーから読んだ分をこの端末に重ねる（同期の「ファイル → 写し」側）。
 * ★置き換えではなく**重ねる**: 同期の途中にこの端末で学習した分を消さないため。
 * ★相手が消した手本は、印によってここで落ちる。
 */
export function mergeSharedStoredExamples(
  kind: ExampleKind,
  incoming: SharedExamples,
): Promise<SharedExamples> {
  return updateShared(kind, (current) => mergeSharedExamples(current, incoming));
}

/**
 * 学習した書き方をすべて消す (「学習した書き方を消去」ボタン)。
 * ★共有フォルダーにつないでいると、この消去は**相手の端末からも消える**（消した印を押すため）。
 *   画面の確認文にその旨を添えること。
 */
export async function clearStoredExamples(
  kind: ExampleKind,
  now: number = Date.now(),
): Promise<void> {
  await updateShared(kind, (current) => ({
    items: [],
    deleted: withDeletedMark(current.deleted, current.items.map((e) => e.id), now),
  }));
}

/** 消した印だけを消す（共有フォルダーの登録を消すときの後片付け。手本は残す） */
export async function clearDeletedExampleMarks(kind: ExampleKind): Promise<void> {
  await deleteMeta(deletedKeyOf(kind));
}
