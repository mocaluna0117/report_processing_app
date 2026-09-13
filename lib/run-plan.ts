// 定期点検の「どのペアを処理するか」「どの結果を出すか」を決める純関数。
//
// ★ここに集めた理由: 画面 (app/page.tsx) は React のテスト基盤が無く自動で確かめられないので、
//   取り違えると被害の大きい規則 (ペアIDの引き継ぎ・処理済みの判定・結果の置き換え) だけを
//   DOM にもストレージにも依存しない形で切り出し、tests/run-plan.test.ts で固定する。
import type { PairView } from "@/components/pair-table";
import type { ResultRow } from "@/lib/process";

/** ペアの状態。画面の表示とチェックの初期値をこれで決める */
export type PairRunState =
  /** まだ処理していない (既定でチェック) */
  | "unprocessed"
  /** 処理済み (既定で外す。チェックすればやり直せる) */
  | "processed"
  /** 前回失敗した (既定でチェック) */
  | "failed"
  /** 同じ施主・点検日の処理済みがある (既定で外す。再ダウンロードした重複ファイルの可能性) */
  | "duplicate"
  /** 写真報告書が無いので処理できない */
  | "no-photo";

/** 抽出結果の表示範囲 */
export type ResultScope = "last" | "all";

/**
 * 同じ報告書かどうかを見る鍵 (点検日＋施主名)。
 * 再ダウンロードの「 (1)」付きやファイル名の表記ゆれは parseFileName が吸収済みなので、
 * ここでは空白だけ落として比べる (氏名の姓名間スペースは表記が揺れるため)。
 */
export function pairKey(pair: Pick<PairView, "date" | "ownerDisplay">): string {
  const owner = pair.ownerDisplay.normalize("NFKC").replace(/[\s　]/g, "");
  return `${pair.date ?? ""}|${owner}`;
}

/**
 * 作り直した自動ペアに、前のペアのIDを引き継ぐ。
 *
 * ★ファイルを足すたびにIDを振り直すと、前回の抽出結果 (ResultRow.pairId) と
 *   結合PDF (IndexedDB の merged ストアのキー) が迷子になり、処理済みかどうかも分からなくなる。
 * ★引き継ぎの鍵は写真報告書のファイルID (pairFiles は写真1つにつき1ペアを作るので一意)。
 *   写真が無いペア (相手待ちの点検報告書) は点検報告書のファイルIDで引き継ぐ。
 */
export function reconcilePairs(
  prev: readonly PairView[],
  next: readonly Omit<PairView, "id">[],
  newId: () => string,
): PairView[] {
  const byPhoto = new Map<string, string>();
  const byInspection = new Map<string, string>();
  for (const p of prev) {
    if (p.photoId) byPhoto.set(p.photoId, p.id);
    else if (p.inspectionId) byInspection.set(p.inspectionId, p.id);
  }
  const used = new Set<string>();
  return next.map((pair) => {
    const carried = pair.photoId
      ? byPhoto.get(pair.photoId)
      : pair.inspectionId
        ? byInspection.get(pair.inspectionId)
        : undefined;
    const id = carried && !used.has(carried) ? carried : newId();
    used.add(id);
    return { ...pair, id };
  });
}

/** ペアごとの状態。結果 (results) が正本で、ペアに「処理済み」の印は持たせない */
export function pairStates(
  pairs: readonly PairView[],
  results: readonly ResultRow[],
): Map<string, PairRunState> {
  const rowOf = new Map(results.map((r) => [r.pairId, r]));
  // 処理済み (失敗を除く) のペアの鍵 → そのペアID
  const doneKeys = new Map<string, string>();
  for (const p of pairs) {
    const row = rowOf.get(p.id);
    if (row && !row.error) doneKeys.set(pairKey(p), p.id);
  }

  const states = new Map<string, PairRunState>();
  for (const p of pairs) {
    const row = rowOf.get(p.id);
    if (row && !row.error) {
      states.set(p.id, "processed");
      continue;
    }
    if (!p.photoId) {
      states.set(p.id, "no-photo");
      continue;
    }
    if (row) {
      states.set(p.id, "failed");
      continue;
    }
    const twin = doneKeys.get(pairKey(p));
    states.set(p.id, twin !== undefined && twin !== p.id ? "duplicate" : "unprocessed");
  }
  return states;
}

/** そのペアを処理できるか (写真報告書が無ければ処理できない) */
export function canRun(state: PairRunState | undefined): boolean {
  return state !== undefined && state !== "no-photo";
}

/** チェックの初期値。まだ結果が無いものと、前回失敗したものを選ぶ */
export function defaultSelection(states: ReadonlyMap<string, PairRunState>): Set<string> {
  const selected = new Set<string>();
  for (const [id, state] of states) {
    if (state === "unprocessed" || state === "failed") selected.add(id);
  }
  return selected;
}

/**
 * ファイルを足したあとのチェック。
 * ★利用者が自分で外したチェックは戻さない (勝手に処理し直さないため)。
 * 新しく現れたペアと、相手が変わったペアだけを足し、無くなった・処理できないペアは落とす。
 */
export function reconcileSelection(args: {
  previous: ReadonlySet<string>;
  states: ReadonlyMap<string, PairRunState>;
  add?: readonly string[];
}): Set<string> {
  const next = new Set<string>();
  for (const id of args.previous) {
    if (canRun(args.states.get(id))) next.add(id);
  }
  for (const id of args.add ?? []) {
    const state = args.states.get(id);
    // ★重複の疑いがあるペアは、新しく現れても既定では選ばない
    //   (同じ報告書をもう一度処理すると、抽出結果の行が二重になるため)
    if (canRun(state) && state !== "duplicate") next.add(id);
  }
  return next;
}

export interface SelectionCounts {
  /** ペアの総数 */
  total: number;
  /** 処理できるペア (写真報告書があるもの) */
  runnable: number;
  processed: number;
  /** 未処理・失敗・重複の合計 (runnable = processed + unprocessed が必ず成り立つ) */
  unprocessed: number;
  selected: number;
  /** 選んだ中の処理済み (やり直しになる件数) */
  selectedProcessed: number;
}

export function selectionCounts(
  states: ReadonlyMap<string, PairRunState>,
  selected: ReadonlySet<string>,
): SelectionCounts {
  let total = 0;
  let runnable = 0;
  let processed = 0;
  let selectedCount = 0;
  let selectedProcessed = 0;
  for (const [id, state] of states) {
    total++;
    if (!canRun(state)) continue;
    runnable++;
    if (state === "processed") processed++;
    if (selected.has(id)) {
      selectedCount++;
      if (state === "processed") selectedProcessed++;
    }
  }
  return {
    total,
    runnable,
    processed,
    unprocessed: runnable - processed,
    selected: selectedCount,
    selectedProcessed,
  };
}

/**
 * 処理結果を差し込む。
 * ★同じペアの行は置き換える (追記すると同じ報告書が二重に並び、Excel へ貼ると重複する)。
 * ★先に古い行を消さない。消してから落ちる (タブを閉じる等) と、その結果を失うため。
 */
export function upsertRow(rows: readonly ResultRow[], row: ResultRow): ResultRow[] {
  const at = rows.findIndex((r) => r.pairId === row.pairId);
  if (at < 0) return [...rows, row];
  return rows.map((r, i) => (i === at ? row : r));
}

/**
 * ペアリング結果と同じ並びに揃える。
 * ペアが残っていない行 (以前の版でIDが振り直された分) は消さずに末尾へ置く。
 */
export function orderRowsByPairs(
  rows: readonly ResultRow[],
  pairs: readonly { id: string }[],
): ResultRow[] {
  const rank = new Map(pairs.map((p, i) => [p.id, i]));
  return [...rows].sort(
    (a, b) =>
      (rank.get(a.pairId) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.pairId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** どのペアにも紐づかない結果 (以前の版でIDが振り直された分)。黙って消さず、画面で知らせる */
export function orphanRowIds(
  rows: readonly ResultRow[],
  pairs: readonly { id: string }[],
): string[] {
  const ids = new Set(pairs.map((p) => p.id));
  return rows.filter((r) => !ids.has(r.pairId)).map((r) => r.pairId);
}

/**
 * 画面に出す行。
 * 「今回の分」は直前の処理実行で作った行だけ。まだ何も実行していない (再読み込み直後など) なら
 * 隠すものが無いので全件を返す。
 */
export function visibleRows(
  rows: readonly ResultRow[],
  scope: ResultScope,
  lastRunIds: ReadonlySet<string>,
): ResultRow[] {
  if (scope === "all" || lastRunIds.size === 0) return [...rows];
  return rows.filter((r) => lastRunIds.has(r.pairId));
}
