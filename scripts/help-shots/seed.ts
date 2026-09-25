/**
 * 写真を撮るまえに、ブラウザの中へ架空のデータを入れる。
 *
 * ★ここの関数は **ブラウザの中で走る**（page.evaluate に渡す）ので、外の変数や import を参照できない。
 *   DB の名前・版・ストア名は lib/storage.ts と同じ値をここにも書く（ずれたら撮影が失敗して気付く）。
 * ★入れたあと page.reload() すること。画面は読み込み直後の1回しか復元しない。
 */

export interface SeedData {
  /** meta ストア（pairs / results / afterCases / {種類}:folderList など） */
  meta?: Record<string, unknown>;
  /** customers ストア（キーは id） */
  customers?: unknown[];
  /** files ストア（中身は空のPDFで足りる。プレビューを開かないカットだけ） */
  files?: { id: string; name: string }[];
}

/** ブラウザの中で走る。IndexedDB を直に開いて put する */
export async function seedInBrowser(data: SeedData): Promise<void> {
  const DB_NAME = "folio";
  const DB_VERSION = 3;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains("files")) database.createObjectStore("files", { keyPath: "id" });
      if (!database.objectStoreNames.contains("merged")) database.createObjectStore("merged");
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
      if (!database.objectStoreNames.contains("customers")) database.createObjectStore("customers", { keyPath: "id" });
    };
  });

  const put = (store: string, value: unknown, key?: IDBValidKey) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      tx.objectStore(store).put(value as never, key);
    });

  for (const [key, value] of Object.entries(data.meta ?? {})) await put("meta", value, key);
  for (const customer of data.customers ?? []) await put("customers", customer);
  for (const file of data.files ?? []) {
    // 中身は読まれない（プレビューを開くカットは撮らない）。PDFの先頭4バイトだけ入れておく
    const blob = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], file.name, { type: "application/pdf" });
    await put("files", { id: file.id, name: file.name, file: blob });
  }
  db.close();
}

/** 画面を開くまえに毎回入れる細工（保存量の表示を固定し、フォルダーの対応を「あり」に見せる） */
export function stubBeforeLoad(arg: {
  login: { sessionToken: string; expiresAt: number; departments: unknown } | null;
}): void {
  const { login } = arg;
  // 保存量は端末で変わるので固定する（写真の差分を出さないため）
  const estimate = async () => ({ usage: 12 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 });
  try {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { ...(navigator.storage ?? {}), estimate },
    });
  } catch {
    /* 使えなくても写真は撮れる（保存量の行が出ないだけ） */
  }
  // headless には無いことがある。無いと「このブラウザでは使えません」という嘘の警告が写る
  if (!("showDirectoryPicker" in window)) {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = () => Promise.reject(new Error("撮影用"));
  }
  if (login) {
    try {
      sessionStorage.setItem("folio:rakuraku:login", JSON.stringify(login));
    } catch {
      /* 入らなければログイン前の画面が写るだけ */
    }
  }
}
