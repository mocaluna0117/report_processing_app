"use client";

import { useEffect, useMemo, useState } from "react";
import { effectiveFields } from "@/lib/after/customer";
import {
  loadCustomers,
  saveCustomerEdits,
  saveReportHandoverDates,
} from "@/lib/after/customer-store";
import { buildHandoverSync, type HandoverSyncItem } from "@/lib/after/match-report";
import type { Customer } from "@/lib/after/types";
import type { ResultRow } from "@/lib/process";
import { isStorageAvailable } from "@/lib/storage";

/** 状態ごとの見せ方 */
const STATUS_LABEL: Record<HandoverSyncItem["status"], string> = {
  update: "更新あり",
  same: "一致",
  invalid: "引渡日が読めません",
  unmatched: "顧客が見つかりません",
  ambiguous: "複数一致",
};

const STATUS_CLASS: Record<HandoverSyncItem["status"], string> = {
  update: "text-amber-800",
  same: "text-slate-500",
  invalid: "text-red-700",
  unmatched: "text-slate-500",
  ambiguous: "text-amber-800",
};

/**
 * 定期点検の報告書の引渡日を、アフターメンテナンスの顧客データへ反映する欄。
 *
 * 処理が終わった時点で、照合が確実なものは自動で更新済み (app/page.tsx)。
 * ここでは何が変わったかを見せ、要確認のものを手で更新できるようにする。
 * 顧客データを取り込んでいないブラウザでは何も出さない。
 */
export function HandoverSync({
  rows,
  processing,
  autoApplied,
}: {
  rows: ResultRow[];
  processing: boolean;
  /** 処理完了時に自動で更新したもの (pairId → 更新前の顧客データの引渡日) */
  autoApplied: Map<string, string | null> | null;
}) {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** この画面で更新した引渡日 (pairId → 反映した値)。「更新しました」の表示に使う */
  const [applied, setApplied] = useState<Map<string, string>>(new Map());
  /** 自動更新を元に戻した行 (もう「自動で更新しました」とは出さない) */
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  // 処理が終わった直後 (自動反映の後) と、手動の再読み込みで読み直す
  useEffect(() => {
    if (processing || !isStorageAvailable()) return;
    let alive = true;
    loadCustomers()
      .then((list) => {
        if (alive) setCustomers(list);
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(`顧客データを読めませんでした (${e instanceof Error ? e.message : String(e)})`);
          setCustomers([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [processing, reloadKey]);

  const items = useMemo(
    () => (customers ? buildHandoverSync(rows, customers) : []),
    [rows, customers],
  );

  const replace = (saved: Customer[]) => {
    if (saved.length === 0) return;
    const byId = new Map(saved.map((c) => [c.id, c]));
    setCustomers((prev) => (prev ?? []).map((c) => byId.get(c.id) ?? c));
  };

  const apply = async (targets: HandoverSyncItem[]) => {
    const updates = targets.flatMap((item) =>
      item.match.customer && item.reportDate
        ? [{ id: item.match.customer.id, date: item.reportDate, pj: item.pj }]
        : [],
    );
    if (updates.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveReportHandoverDates(updates);
      replace(saved);
      // 実際に書けた顧客だけを「更新しました」にする (別タブで消された顧客は飛ばされる)
      const savedIds = new Set(saved.map((c) => c.id));
      const written = targets.filter((t) => t.match.customer && savedIds.has(t.match.customer.id));
      if (written.length < targets.length) {
        setError("一部の顧客が見つかりませんでした (顧客データを再読み込みしてください)");
      }
      setApplied((prev) => {
        const next = new Map(prev);
        for (const item of written) if (item.reportDate) next.set(item.pairId, item.reportDate);
        return next;
      });
      setReverted((prev) => {
        if (!written.some((t) => prev.has(t.pairId))) return prev;
        const next = new Set(prev);
        for (const item of written) next.delete(item.pairId);
        return next;
      });
    } catch (e) {
      setError(`引渡日を保存できませんでした (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  /** 自動で更新した分を元に戻す (取り込み値と同じ値なら修正そのものが外れる) */
  const revert = async (item: HandoverSyncItem, previous: string | null) => {
    if (!item.match.customer) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveCustomerEdits(item.match.customer.id, {
        handoverDate: previous,
      });
      if (saved) replace([saved]);
      setApplied((prev) => {
        const next = new Map(prev);
        next.delete(item.pairId);
        return next;
      });
      setReverted((prev) => new Set(prev).add(item.pairId));
    } catch (e) {
      setError(`元に戻せませんでした (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  // 顧客データを取り込んでいない画面には出さない
  if (customers !== null && customers.length === 0 && !error) return null;
  if (customers === null) return null;

  const pending = items.filter((i) => i.status === "update");
  const autoCount = [...(autoApplied?.keys() ?? [])].filter((id) => !reverted.has(id)).length;
  const counts = {
    same: items.filter((i) => i.status === "same").length,
    missing: items.filter((i) => i.status === "unmatched" || i.status === "ambiguous").length,
  };

  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          引渡日を顧客データに反映
          <span className="ml-2 text-sm font-normal text-slate-500">
            報告書の引渡日の方が確かなので、照合できた顧客の引渡日を書き換えます
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={busy || processing}
            className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:cursor-default disabled:opacity-50"
          >
            顧客データを再読み込み
          </button>
          {pending.length > 0 && (
            <button
              type="button"
              onClick={() => void apply(pending)}
              disabled={busy || processing}
              className="cursor-pointer rounded-md border border-emerald-600 bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-default disabled:opacity-50"
            >
              残りをすべて更新 ({pending.length}件)
            </button>
          )}
        </div>
      </div>

      {autoCount > 0 && (
        <p className="mt-2 rounded bg-emerald-50 px-2 py-1.5 text-sm text-emerald-900">
          {autoCount}件の引渡日を自動で更新しました (照合が確実なものだけ)。
        </p>
      )}
      {error && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-sm text-red-700">{error}</p>
      )}

      <p className="mt-2 text-xs text-slate-500">
        更新あり {pending.length}件 / 一致 {counts.same}件 / 顧客が決まらない {counts.missing}件
      </p>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="border-b border-slate-200 px-2 py-1.5">施主</th>
              <th className="border-b border-slate-200 px-2 py-1.5">PJ</th>
              <th className="border-b border-slate-200 px-2 py-1.5">報告書の引渡日</th>
              <th className="border-b border-slate-200 px-2 py-1.5">顧客データの引渡日</th>
              <th className="border-b border-slate-200 px-2 py-1.5">状態</th>
              <th className="border-b border-slate-200 px-2 py-1.5">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const matched = item.match.customer;
              const fields = matched ? effectiveFields(matched) : null;
              const appliedDate = applied.get(item.pairId);
              const autoPrevious = autoApplied?.get(item.pairId);
              const wasAuto = (autoApplied?.has(item.pairId) ?? false) && !reverted.has(item.pairId);
              return (
                <tr key={item.pairId} className="align-top">
                  <td className="border-b border-slate-100 px-2 py-1.5">
                    <p className="font-medium">{item.ownerDisplay || "－"}</p>
                    {fields && (
                      <p className="text-xs text-slate-500">
                        {fields.ownerName} / {fields.address}
                      </p>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5 whitespace-nowrap">
                    {item.pj ?? "－"}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5 whitespace-nowrap">
                    {item.reportDate ?? "－"}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5 whitespace-nowrap">
                    {item.customerDate ?? "－"}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5">
                    {appliedDate ? (
                      <span className="font-medium text-emerald-700">更新しました</span>
                    ) : wasAuto ? (
                      <span className="font-medium text-emerald-700">自動で更新しました</span>
                    ) : (
                      <>
                        <span className={`font-medium ${STATUS_CLASS[item.status]}`}>
                          {STATUS_LABEL[item.status]}
                        </span>
                        <p className="text-xs text-slate-500">
                          {item.holdReason ?? item.match.reason}
                        </p>
                        {item.match.alternatives && item.match.alternatives.length > 0 && (
                          <p className="text-xs text-slate-500">
                            候補:{" "}
                            {item.match.alternatives
                              .slice(0, 3)
                              .map((c) => effectiveFields(c).ownerName || c.id)
                              .join(" / ")}
                          </p>
                        )}
                      </>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-2 py-1.5">
                    {wasAuto && !appliedDate ? (
                      <button
                        type="button"
                        onClick={() => void revert(item, autoPrevious ?? null)}
                        disabled={busy || processing}
                        className="cursor-pointer whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:cursor-default disabled:opacity-50"
                      >
                        元に戻す
                      </button>
                    ) : item.status === "update" && !appliedDate ? (
                      <button
                        type="button"
                        onClick={() => void apply([item])}
                        disabled={busy || processing}
                        className="cursor-pointer whitespace-nowrap rounded-md border border-emerald-600 bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-default disabled:opacity-50"
                      >
                        更新
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        反映した引渡日は「手直し」として保存されるので、顧客データを取り込み直しても残ります
        (アフターメンテナンスの顧客カードで確認・取り消しできます)。
        顧客データはこのブラウザの中だけにあるため、取り込んだ端末で処理してください。
      </p>
    </section>
  );
}
