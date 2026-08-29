"use client";

// 両方の画面で共通の「ブラウザ内保存」まわり (復元 → 保存再開 → 保存量の表示 → 消去)。
import { useEffect, useRef, useState } from "react";
import { clearLocalFonts, loadLocalFontInfo, type LocalFontInfo } from "@/lib/report/fonts";
import { estimateUsage, isQuotaError, isStorageAvailable } from "@/lib/storage";

export interface PersistenceOptions {
  /** 保存済みの内容を画面へ戻す (成功したら保存を再開する) */
  restore: () => Promise<{ partialErrors: string[] }>;
  /** この画面に保存データが残っているか (消去の導線を出すため) */
  hasSaved: () => Promise<boolean>;
}

export interface Persistence {
  /** 復元の試行が終わったか (終わるまで操作させない) */
  restored: boolean;
  canPersist: boolean;
  storageError: string | null;
  setStorageError: (value: string | null) => void;
  hasSaved: boolean;
  refreshHasSaved: () => void;
  usageBytes: number | null;
  refreshUsage: () => void;
  fontInfo: LocalFontInfo | null;
  refreshFontInfo: () => void;
  /** 保存の失敗は作業を止めない (警告だけ出す) */
  persist: (task: () => Promise<void>) => void;
  /** 登録した書体を消す (顧客データの消去とは別操作) */
  clearFont: () => Promise<void>;
}

export function usePersistence(options: PersistenceOptions): Persistence {
  const [restored, setRestored] = useState(false);
  const [canPersist, setCanPersist] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [usageBytes, setUsageBytes] = useState<number | null>(null);
  const [fontInfo, setFontInfo] = useState<LocalFontInfo | null>(null);
  // 長時間走る処理のコールバックが古い値を掴み続けないように ref でも持つ
  const canPersistRef = useRef(false);
  // 実装が毎レンダー変わっても、復元は初回だけにする
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const refreshUsage = () => {
    void estimateUsage().then(setUsageBytes);
  };
  const refreshHasSaved = () => {
    void optionsRef.current
      .hasSaved()
      .then(setHasSaved)
      .catch(() => {});
  };
  const refreshFontInfo = () => {
    void loadLocalFontInfo()
      .then(setFontInfo)
      .catch(() => setFontInfo(null));
  };

  // 再読み込み後も作業を続けられるよう、前回の内容を復元する
  useEffect(() => {
    refreshFontInfo();
    if (!isStorageAvailable()) {
      setRestored(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { partialErrors } = await optionsRef.current.restore();
        if (cancelled) return;
        if (partialErrors.length > 0) {
          setStorageError(`前回の内容を一部復元できませんでした (${partialErrors.join(" / ")})`);
        }
        // 復元できたので保存を再開してよい
        canPersistRef.current = true;
        setCanPersist(true);
      } catch (e) {
        if (!cancelled) {
          // 復元できていないので保存もしない (空の状態で保存データを上書きしないため)
          setStorageError(
            `前回の内容を復元できませんでした (${e instanceof Error ? e.message : String(e)})。` +
              "このタブでは保存を停止します。再読み込みすると復元を試み直せます",
          );
        }
      } finally {
        if (!cancelled) {
          setRestored(true);
          refreshHasSaved();
          refreshUsage();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (task: () => Promise<void>) => {
    if (!canPersistRef.current || !isStorageAvailable()) return;
    void task().then(
      () => {
        setStorageError((prev) => (prev?.startsWith("保存できませんでした") ? null : prev));
        setHasSaved(true);
        refreshUsage();
      },
      (e) => {
        setStorageError(
          isQuotaError(e)
            ? "保存容量が足りません。作業を終えた分は消去してから続けてください" +
              " (このままでも処理は続けられますが、再読み込みすると失われます)"
            : `保存できませんでした (${e instanceof Error ? e.message : String(e)})。再読み込みすると内容が失われる可能性があります`,
        );
      },
    );
  };

  const clearFont = async () => {
    if (!confirm("登録した書体を消して、同梱の書体 (Noto Sans JP) に戻します。よろしいですか？")) {
      return;
    }
    try {
      await clearLocalFonts();
    } catch (e) {
      setStorageError(
        `書体の登録を消せませんでした (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    refreshFontInfo();
    refreshUsage();
  };

  return {
    restored,
    canPersist,
    storageError,
    setStorageError,
    hasSaved,
    refreshHasSaved,
    usageBytes,
    refreshUsage,
    fontInfo,
    refreshFontInfo,
    persist,
    clearFont,
  };
}
