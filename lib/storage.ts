"use client";

// アップロードしたPDF・ペアリング・処理結果をブラウザの IndexedDB に保存し、再読み込み後に復元する。
// - localStorage は約5MB・文字列のみで、50MB級のPDFを扱う本アプリには使えない
// - IndexedDB は File/Blob をそのまま保存でき、容量も数百MB以上ある
// - 保存先はこのブラウザ (この端末・このオリジン) の中だけ。サーバーへは送らない
// - 顧客情報を含むため、「保存データを消去」で明示的に消せるようにしている
import type { PairView } from "@/components/pair-table";
import type { AfterCase } from "@/lib/after/types";
import type { ResultRow, UploadedFile } from "@/lib/process";
import { AFTER_REPORT_OPTIONS, normalizeReportOptions } from "@/lib/report/model";
import { COLUMNS } from "@/lib/tsv";

const DB_NAME = "folio";
/**
 * v2: アフターメンテナンスの顧客データ (customers) を追加
 * v3: customers の使っていない source 索引を外す
 */
const DB_VERSION = 3;
/** アップロードしたPDF (id → UploadedFile。File は structured clone でそのまま保存できる) */
const STORE_FILES = "files";
/** 結合PDF (pairId → Blob)。大きいので結果JSONとは別に、処理完了時に1回だけ書く */
const STORE_MERGED = "merged";
/** その他 (pairs / results / 受付一覧 のJSON) */
const STORE_META = "meta";
/** アフターメンテナンスの顧客データ (id → Customer)。件数が多いので専用ストアに置く */
export const STORE_CUSTOMERS = "customers";
const META_PAIRS = "pairs";
const META_RESULTS = "results";
/** アフターメンテナンスの受付一覧 */
const META_AFTER_CASES = "afterCases";

/**
 * 「保存データを消去」(定期点検) で消す meta キー。
 * アフターメンテナンスの顧客データ・受付一覧はここに含めない
 * (それぞれ専用のボタンで消す。定期点検の作業終了で顧客データまで消えないようにする)。
 */
const INSPECTION_META_KEYS: readonly string[] = [META_PAIRS, META_RESULTS];
/**
 * 完了報告書PDFの書体登録 (利用者が自分の端末のフォントを登録したもの)。
 * 設定なので「保存データを消去」では消さない (専用のボタンで消す)。
 * 顧客情報を含む値をこれらのキーで保存してはいけない。
 */
export const SETTING_KEY_FONT_INFO = "report:fontInfo";
export const SETTING_KEY_FONT_REGULAR = "report:fontRegular";
export const SETTING_KEY_FONT_BOLD = "report:fontBold";

export function isStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/** 容量不足によるエラーか (メッセージを分かりやすくするため) */
export function isQuotaError(e: unknown): boolean {
  return (
    (e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22)) ||
    /quota/i.test(String(e))
  );
}

/** 保存に使っている概算バイト数 (表示用。取得できなければ null) */
export async function estimateUsage(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    return typeof est?.usage === "number" ? est.usage : null;
  } catch {
    return null;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    // biome-ignore lint/style/useConst: onsuccess ハンドラから自分自身を参照するため
    let p: Promise<IDBDatabase>;
    p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_MERGED)) db.createObjectStore(STORE_MERGED);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_CUSTOMERS)) {
          // 取り込み元での絞り込みは読み込んだ後にJSで行うので、索引は張らない
          db.createObjectStore(STORE_CUSTOMERS, { keyPath: "id" });
        } else if (req.transaction) {
          // v2 で作った source 索引は使っていない。付いたままだと顧客データを取り込み直すたび
          // (数千件の書き戻し) に索引の作り直しが走って遅くなるので外す
          const store = req.transaction.objectStore(STORE_CUSTOMERS);
          if (store.indexNames.contains("source")) store.deleteIndex("source");
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 別タブでのバージョン変更や異常終了で閉じられたら、次回は開き直す
        const forget = () => {
          if (dbPromise === p) dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          forget();
        };
        // ブラウザ側からサイトデータを消された場合など (放置すると死んだ接続を使い続ける)
        db.onclose = forget;
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けませんでした"));
      req.onblocked = () => reject(new Error("IndexedDB が他のタブでロックされています"));
    });
    // 失敗はキャッシュしない (一時的な失敗で以降ずっと保存できなくなるのを防ぐ)。
    // dbPromise には p 自身を入れ、catch は「忘れる」ためだけに繋ぐ
    // (p.catch(...) の戻り値を入れると同一性の比較が常に false になり解除できない)
    dbPromise = p;
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
  }
  return dbPromise;
}

/**
 * 1トランザクションで store を操作する。fn は複数の put/delete を発行してよい。
 * fn の中で IndexedDB 以外の await を挟むとトランザクションが閉じてしまうので注意。
 */
export async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    Promise.resolve(fn(t.objectStore(store))).then(
      (r) => {
        result = r;
      },
      (e) => {
        try {
          t.abort();
        } catch {
          // 既に終了していれば無視
        }
        reject(e);
      },
    );
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? new Error("IndexedDB の書き込みに失敗しました"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB のトランザクションが中断されました"));
  });
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** store の全レコードを key → value の Map で読む */
async function readAll<T>(store: string): Promise<Map<IDBValidKey, T>> {
  return withStore(store, "readonly", async (s) => {
    const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
    const map = new Map<IDBValidKey, T>();
    keys.forEach((k, i) => map.set(k, values[i] as T));
    return map;
  });
}

// ---------- ファイル ----------

export async function saveFiles(entries: UploadedFile[]): Promise<void> {
  if (entries.length === 0) return;
  await withStore(STORE_FILES, "readwrite", (s) => {
    for (const e of entries) s.put({ id: e.id, name: e.name, file: e.file });
  });
}

export async function loadFiles(): Promise<UploadedFile[]> {
  const all = await readAll<UploadedFile>(STORE_FILES);
  return [...all.values()].filter(
    (f) => f && typeof f.id === "string" && typeof f.name === "string" && f.file instanceof Blob,
  );
}

// ---------- 任意の設定値 (meta ストアの汎用キー) ----------

/**
 * 設定などを meta ストアに置く。完了報告書のフォント登録に使う。
 * 「保存データを消去」で消えるのは INSPECTION_META_KEYS に挙げたキーだけなので、
 * ここに置いた値は明示的に消さない限り残る (顧客情報を置くなら消す導線も用意すること)。
 */
export async function saveMeta<T>(key: string, value: T): Promise<void> {
  await withStore(STORE_META, "readwrite", (s) => {
    s.put(value, key);
  });
}

export async function loadMeta<T>(key: string): Promise<T | undefined> {
  return (await withStore(STORE_META, "readonly", (s) => request(s.get(key)))) as T | undefined;
}

export async function deleteMeta(key: string): Promise<void> {
  await withStore(STORE_META, "readwrite", (s) => {
    s.delete(key);
  });
}

// ---------- ペアリング ----------

/**
 * ペアリングを保存する。
 * 空配列は「まだ復元できていない」状態と区別できないため、既存データがある場合は上書きしない
 * (意図的に空にするのは clearAll のみ)。
 */
export async function savePairs(pairs: PairView[]): Promise<void> {
  await withStore(STORE_META, "readwrite", async (s) => {
    if (pairs.length === 0) {
      const existing = await request(s.get(META_PAIRS));
      if (Array.isArray(existing) && existing.length > 0) return;
    }
    s.put(pairs, META_PAIRS);
  });
}

export async function loadPairs(validFileIds: Set<string>): Promise<PairView[]> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(META_PAIRS)));
  if (!Array.isArray(raw)) return [];
  return (raw as PairView[])
    .filter((p) => p && typeof p.id === "string")
    .map((p) => ({
      ...p,
      // 保存後に消えたファイルを参照していたら外す
      photoId: p.photoId && validFileIds.has(p.photoId) ? p.photoId : null,
      inspectionId: p.inspectionId && validFileIds.has(p.inspectionId) ? p.inspectionId : null,
    }))
    .filter((p) => p.photoId || p.inspectionId);
}

// ---------- 処理結果 ----------

/** 結果のJSON部分を保存する (結合PDFは含めない。セル編集のたびに呼ばれるので軽く保つ) */
export async function saveResults(rows: ResultRow[]): Promise<void> {
  const stripped = rows.map((r) => ({ ...r, merged: null }));
  await withStore(STORE_META, "readwrite", async (s) => {
    // 空配列で既存の結果を消してしまわないようにする (消すのは clearResults / clearAll)
    if (stripped.length === 0) {
      const existing = await request(s.get(META_RESULTS));
      if (Array.isArray(existing) && existing.length > 0) return;
    }
    s.put(stripped, META_RESULTS);
  });
}

/** 結合PDFを保存する (処理完了時に1回) */
export async function saveMergedPdf(pairId: string, blob: Blob): Promise<void> {
  await withStore(STORE_MERGED, "readwrite", (s) => {
    s.put(blob, pairId);
  });
}

/**
 * 前回の結果を消す (処理実行の開始時)。
 * pairIds を渡した場合はその結合PDFだけを消す (他タブ・他セッションの分を巻き込まない)。
 */
export async function clearResults(pairIds?: string[]): Promise<void> {
  await withStore(STORE_META, "readwrite", (s) => {
    s.delete(META_RESULTS);
  });
  await withStore(STORE_MERGED, "readwrite", (s) => {
    if (pairIds) {
      for (const id of pairIds) s.delete(id);
    } else {
      s.clear();
    }
  });
}

/** 結果に紐づかない結合PDF (前回セッションの残り) を掃除して容量を戻す */
export async function collectGarbage(livePairIds: Set<string>): Promise<void> {
  const keys = await withStore(STORE_MERGED, "readonly", (s) => request(s.getAllKeys()));
  const stale = keys.filter((k) => typeof k === "string" && !livePairIds.has(k));
  if (stale.length === 0) return;
  await withStore(STORE_MERGED, "readwrite", (s) => {
    for (const k of stale) s.delete(k);
  });
}

function isResultRowLike(r: unknown): r is ResultRow {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.pairId === "string" &&
    Array.isArray(o.cells) &&
    o.cells.length === COLUMNS.length &&
    Array.isArray(o.confidences) &&
    Array.isArray(o.categories) &&
    Array.isArray(o.warnings)
  );
}

export async function loadResults(): Promise<ResultRow[]> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(META_RESULTS)));
  if (!Array.isArray(raw)) return [];
  // 結合PDFが読めなくても抽出結果は返す (再処理せずにセルの内容を使えるようにする)
  const merged = await readAll<Blob>(STORE_MERGED).catch(() => new Map<IDBValidKey, Blob>());
  return raw.filter(isResultRowLike).map((r) => ({
    ...r,
    // 古い保存データに無いフィールドは既定値で埋める
    mail: r.mail ?? { ownerKana: "", kanaConfidence: "fail", kanaAlternatives: [], contacts: [] },
    report: normalizeReportOptions(r.report),
    merged: (merged.get(r.pairId) as Blob | undefined) ?? null,
  }));
}

// ---------- まとめて ----------

export interface RestoredSession {
  files: UploadedFile[];
  pairs: PairView[];
  results: ResultRow[];
  /** 一部だけ読めなかった場合の理由 (空なら完全に復元できた) */
  partialErrors: string[];
}

/**
 * 保存されている内容をまとめて読む (何も無ければ空)。
 * 一部が壊れていても読めたものは返す (全か無かにすると、1件の破損で作業内容を全部失う)。
 */
export async function loadSession(): Promise<RestoredSession> {
  const partialErrors: string[] = [];
  const attempt = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      partialErrors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  const files = await attempt("PDF", loadFiles, [] as UploadedFile[]);
  const pairs = await attempt(
    "ペアリング",
    () => loadPairs(new Set(files.map((f) => f.id))),
    [] as PairView[],
  );
  const results = await attempt("抽出結果", loadResults, [] as ResultRow[]);
  return { files, pairs, results, partialErrors };
}

/**
 * 定期点検の保存データが1件でも残っているか (画面の状態とは独立に判定する)。
 * アフターメンテナンスの顧客データ・受付一覧は数えない (別のボタンで消すため)。
 */
export async function hasStoredData(): Promise<boolean> {
  for (const store of [STORE_FILES, STORE_MERGED]) {
    const n = await withStore(store, "readonly", (s) => request(s.count()));
    if (n > 0) return true;
  }
  // 消去後に書き戻される空の記録は「保存データあり」と数えない
  const values = await withStore(STORE_META, "readonly", async (s) =>
    Promise.all(INSPECTION_META_KEYS.map((key) => request(s.get(key)))),
  );
  return values.some((value) => Array.isArray(value) && value.length > 0);
}

/**
 * 定期点検の保存データを消す (「保存データを消去」ボタン)。
 * 消すのは 写真報告書・点検報告書・結合PDF・ペアリング・抽出結果 だけで、
 * アフターメンテナンスの顧客データ・受付一覧と、書体の登録は残す
 * (それぞれ専用のボタンで消す)。
 */
export async function clearAll(): Promise<void> {
  for (const store of [STORE_FILES, STORE_MERGED]) {
    await withStore(store, "readwrite", (s) => {
      s.clear();
    });
  }
  await withStore(STORE_META, "readwrite", (s) => {
    for (const key of INSPECTION_META_KEYS) s.delete(key);
  });
}

// ---------- アフターメンテナンスの受付一覧 ----------

/** 受付一覧を保存する (結果と同じく、空配列で既存を消してしまわないようにする) */
export async function saveAfterCases(cases: AfterCase[]): Promise<void> {
  await withStore(STORE_META, "readwrite", async (s) => {
    if (cases.length === 0) {
      const existing = await request(s.get(META_AFTER_CASES));
      if (Array.isArray(existing) && existing.length > 0) return;
    }
    s.put(cases, META_AFTER_CASES);
  });
}

export async function loadAfterCases(): Promise<AfterCase[]> {
  const raw = await withStore(STORE_META, "readonly", (s) => request(s.get(META_AFTER_CASES)));
  if (!Array.isArray(raw)) return [];
  return raw.filter(isResultRowLike).map((r) => {
    const row = r as unknown as AfterCase;
    return {
      ...row,
      kind: "after" as const,
      mail: row.mail ?? { ownerKana: "", kanaConfidence: "fail", kanaAlternatives: [], contacts: [] },
      report: normalizeReportOptions(row.report, AFTER_REPORT_OPTIONS),
      merged: null,
    };
  });
}

/** 受付一覧だけを消す (「受付一覧を消去」ボタン) */
export async function clearAfterCases(): Promise<void> {
  await withStore(STORE_META, "readwrite", (s) => {
    s.delete(META_AFTER_CASES);
  });
}
