"use client";

// 「学習した書き方」の保存 (IndexedDB の meta ストア)。
// 伏せ字済みの本文だけを置き、サーバーへは要約のたびに手本として送る。
// 設定扱いなので「保存データを消去」「受付一覧を消去」では消えず、専用のボタンで消す。
//
// 定期点検 (不具合項目 → 点検内容) とアフターメンテナンス (受付メモ → アフター受付内容) は
// 入力の形もプロンプトも違うので、手本の一覧を別々に持つ。
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
  withStore,
} from "@/lib/storage";

/** どちらの画面の手本か */
export type ExampleKind = "inquiry" | "inspection";

const keyOf = (kind: ExampleKind) =>
  kind === "inquiry" ? META_INQUIRY_EXAMPLES : META_INSPECTION_EXAMPLES;

const valid = (raw: unknown): InquiryExample[] =>
  Array.isArray(raw) ? raw.filter(isInquiryExampleLike) : [];

export async function loadExamples(kind: ExampleKind): Promise<InquiryExample[]> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(keyOf(kind))));
  return valid(raw);
}

/**
 * 読み込み → 更新 → 書き込みを1トランザクションで行う。
 * 「配列をまるごと保存」にすると最後の1件を消せなくなるため、操作ごとに読み直す。
 */
async function updateExamples(
  kind: ExampleKind,
  fn: (current: InquiryExample[]) => InquiryExample[],
): Promise<InquiryExample[]> {
  const key = keyOf(kind);
  let next: InquiryExample[] = [];
  await withStore(STORE_META, "readwrite", async (store) => {
    const current = valid(await request(store.get(key)));
    next = fn(current);
    if (next.length === 0) store.delete(key);
    else store.put(next, key);
  });
  return next;
}

/** 1件を学習する / 学習し直す */
export function upsertStoredExample(
  kind: ExampleKind,
  example: InquiryExample,
): Promise<InquiryExample[]> {
  return updateExamples(kind, (current) => upsertExample(current, example));
}

/** 1件の学習を消す */
export function deleteStoredExample(
  kind: ExampleKind,
  id: string,
): Promise<InquiryExample[]> {
  return updateExamples(kind, (current) => current.filter((e) => e.id !== id));
}

/** 書き出したJSONを取り込む (他の端末から移すとき。同じ id は新しい方を採る) */
export function mergeStoredExamples(
  kind: ExampleKind,
  incoming: InquiryExample[],
): Promise<InquiryExample[]> {
  return updateExamples(kind, (current) => mergeExamples(current, incoming));
}

/** 学習した書き方をすべて消す (「学習した書き方を消去」ボタン) */
export async function clearStoredExamples(kind: ExampleKind): Promise<void> {
  await deleteMeta(keyOf(kind));
}
