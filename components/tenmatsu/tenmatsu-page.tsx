"use client";

import { useEffect, useState } from "react";
import { TenmatsuFolderPage } from "@/components/tenmatsu/tenmatsu-folder-page";
import { TenmatsuLocalServerPage } from "@/components/tenmatsu/tenmatsu-local-server-page";
import { isStorageAvailable } from "@/lib/storage";
import { DOC_KIND_BY_ID, type DocKindId } from "@/lib/tenmatsu/kinds";
import { hasActiveRun } from "@/lib/tenmatsu/local/client";
import { type TenmatsuSource, defaultSource, loadSource, loadToken, saveSource } from "@/lib/tenmatsu/store";

/** このページ読み込みの中で決まった取得の方法（タブを行き来しても読み直さない） */
const chosen = new Map<DocKindId, TenmatsuSource>();


/**
 * 顛末書・専決決裁書・捺印決裁書のタブ。取得の方法を切り替えられるようにしてある。
 * - 新しい方式 … このブラウザで取得して、選んだフォルダーへ保存（PCにツールを入れなくてよい）
 * - 今までの方式 … PCで動かしている顛末書取得ツール（Python）につなぐ
 *
 * ★保存していなければ、旧方式のトークンを登録済みの人は今までの方式、そうでない人は新しい方式から始まる。
 * ★2つの方式を同時に使わない（記録が別々なので、同じ伝票を二重に取得する）。
 */
export function TenmatsuPage({ kind: kindId }: { kind: DocKindId }) {
  const kind = DOC_KIND_BY_ID[kindId];
  const [source, setSource] = useState<TenmatsuSource | null>(() => chosen.get(kindId) ?? null);

  useEffect(() => {
    if (source !== null) return;
    if (!isStorageAvailable()) {
      setSource("folder");
      return;
    }
    let alive = true;
    void (async () => {
      const saved = await loadSource(kindId).catch(() => null);
      const next = saved ?? defaultSource((await loadToken().catch(() => null)) !== null);
      if (!alive) return;
      chosen.set(kindId, next);
      setSource(next);
    })();
    return () => {
      alive = false;
    };
  }, [kindId, source]);

  const change = (next: TenmatsuSource) => {
    if (next === source) return;
    if (hasActiveRun()) {
      alert("取得の途中は方式を切り替えられません。取得が終わってから切り替えてください");
      return;
    }
    chosen.set(kindId, next);
    setSource(next);
    if (isStorageAvailable()) void saveSource(kindId, next).catch(() => undefined);
  };

  if (source === null) {
    return <p className="mt-4 text-sm text-slate-500">読み込んでいます…</p>;
  }

  const header = (
    <fieldset className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
      <legend className="px-1 text-xs font-semibold text-slate-600">取得の方法</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={`${kindId}-source`} checked={source === "folder"} onChange={() => change("folder")} />
          このブラウザで取得して、選んだフォルダーへ保存する
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-900">新しい方式</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`${kindId}-source`}
            checked={source === "local-server"}
            onChange={() => change("local-server")}
          />
          PCで動かしている顛末書取得ツールにつなぐ
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">今までの方式</span>
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        2つの方式は取得の記録が別々です。同じ{kind.label}を二重に取得しないよう、どちらか一方だけを使ってください。
      </p>
    </fieldset>
  );

  return source === "folder" ? (
    <TenmatsuFolderPage kind={kindId} header={header} />
  ) : (
    <TenmatsuLocalServerPage kind={kindId} header={header} />
  );
}
