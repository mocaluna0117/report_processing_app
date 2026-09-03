"use client";

// 「学習した書き方」の保存 (IndexedDB の meta ストア)。
// 伏せ字済みの本文だけを置き、サーバーへは要約のたびに手本として送る。
// 設定扱いなので「保存データを消去」「受付一覧を消去」では消えず、専用のボタンで消す。
import {
  type InquiryExample,
  isInquiryExampleLike,
  mergeExamples,
  upsertExample,
} from "@/lib/summarize/examples";
import { META_INQUIRY_EXAMPLES, STORE_META, deleteMeta, request, withStore } from "@/lib/storage";

const valid = (raw: unknown): InquiryExample[] =>
  Array.isArray(raw) ? raw.filter(isInquiryExampleLike) : [];

export async function loadInquiryExamples(): Promise<InquiryExample[]> {
  const raw = await withStore(STORE_META, "readonly", (s) =>
    request(s.get(META_INQUIRY_EXAMPLES)),
  );
  return valid(raw);
}

/**
 * 読み込み → 更新 → 書き込みを1トランザクションで行う。
 * 「配列をまるごと保存」にすると最後の1件を消せなくなるため、操作ごとに読み直す。
 */
async function updateExamples(
  fn: (current: InquiryExample[]) => InquiryExample[],
): Promise<InquiryExample[]> {
  let next: InquiryExample[] = [];
  await withStore(STORE_META, "readwrite", async (store) => {
    const current = valid(await request(store.get(META_INQUIRY_EXAMPLES)));
    next = fn(current);
    if (next.length === 0) store.delete(META_INQUIRY_EXAMPLES);
    else store.put(next, META_INQUIRY_EXAMPLES);
  });
  return next;
}

/** 1件を学習する / 学習し直す */
export function upsertInquiryExample(example: InquiryExample): Promise<InquiryExample[]> {
  return updateExamples((current) => upsertExample(current, example));
}

/** 1件の学習を消す */
export function deleteInquiryExample(id: string): Promise<InquiryExample[]> {
  return updateExamples((current) => current.filter((e) => e.id !== id));
}

/** 書き出したJSONを取り込む (他の端末から移すとき。同じ id は新しい方を採る) */
export function mergeInquiryExamples(incoming: InquiryExample[]): Promise<InquiryExample[]> {
  return updateExamples((current) => mergeExamples(current, incoming));
}

/** 学習した書き方をすべて消す (「学習した書き方を消去」ボタン) */
export async function clearInquiryExamples(): Promise<void> {
  await deleteMeta(META_INQUIRY_EXAMPLES);
}
