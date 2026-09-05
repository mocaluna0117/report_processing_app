"use client";

import { useEffect, useMemo, useState } from "react";
import { effectiveFields } from "@/lib/after/customer";
import { loadCustomers, saveTenmatsuStaff } from "@/lib/after/customer-store";
import {
  type StaffField,
  type StaffSyncRow,
  type StaffSyncStatus,
  STAFF_FIELDS,
  buildStaffSync,
  staffUpdatesFor,
} from "@/lib/after/match-staff";
import type { Customer } from "@/lib/after/types";
import { isStorageAvailable } from "@/lib/storage";
import type { ListItem } from "@/lib/tenmatsu/client";

/** 状態ごとの見せ方 (引渡日の反映欄と同じ並び) */
const STATUS_LABEL: Record<StaffSyncStatus, string> = {
  update: "反映できます",
  same: "一致",
  kept: "入っているので触りません",
  conflict: "食い違い",
  empty: "顛末書に無し",
};

const STATUS_CLASS: Record<StaffSyncStatus, string> = {
  update: "text-amber-800",
  same: "text-slate-500",
  kept: "text-slate-500",
  conflict: "text-amber-800",
  empty: "text-slate-500",
};

const CELL = "border-b border-slate-100 px-2 py-1.5 align-top";
const SMALL_BUTTON =
  "cursor-pointer whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:cursor-default disabled:opacity-50";
const APPLY_BUTTON =
  "cursor-pointer whitespace-nowrap rounded-md border border-emerald-600 bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-default disabled:opacity-50";

const customerLabel = (customer: Customer) => {
  const f = effectiveFields(customer);
  return f.propertyName || f.ownerName || customer.id;
};

/**
 * 顛末書の「どこで」から読んだ監督・営業を、アフターメンテナンスの
 * お客様の情報へ反映する欄。突き合わせは **PJコードの上8桁**。
 *
 * 自動では書かない。何が変わるかを見せてからボタンで反映する
 * (引渡日の反映欄 components/handover-sync.tsx と同じ作り)。
 * 顧客データを取り込んでいないブラウザでは何も出さない。
 */
export function TenmatsuStaffSync({
  items,
  listFresh,
  disabled,
}: {
  /** /list の全行。絞り込みで反映できる範囲が変わってはいけないので、表示中の行ではない */
  items: ListItem[];
  /** この画面でサーバーから取り直したか (前回の写しなら断りを出す) */
  listFresh: boolean;
  /** 取得中は触らせない */
  disabled: boolean;
}) {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** この画面で反映した現場 (PJ上8桁 → 反映した件数) */
  const [applied, setApplied] = useState<Map<string, number>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isStorageAvailable()) return;
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
  }, [reloadKey]);

  const sync = useMemo(
    () => buildStaffSync(items, customers ?? []),
    [items, customers],
  );

  // 顧客データを取り込んでいないブラウザには出さない (引渡日の反映欄と同じ)
  if (!customers || customers.length === 0) return null;

  const pending = sync.rows.filter((r) => r.updates.length > 0);
  const counts = {
    update: pending.length,
    same: sync.rows.filter((r) =>
      STAFF_FIELDS.every(({ key }) => r.fields[key].status === "same")).length,
    conflict: sync.rows.filter((r) =>
      STAFF_FIELDS.some(({ key }) => r.fields[key].status === "conflict")).length,
    unmatched: sync.rows.filter((r) => r.customers.length === 0).length,
  };

  const apply = async (rows: StaffSyncRow[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const row of rows) {
        const saved = await saveTenmatsuStaff(
          row.updates.map((u) => ({ ...u, pj: row.key })),
        );
        if (saved.length > 0) {
          setApplied((prev) => new Map(prev).set(row.key, saved.length));
        }
      }
      setCustomers(await loadCustomers());
    } catch (e) {
      setError(`反映できませんでした (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  const fieldText = (row: StaffSyncRow, field: StaffField) => {
    const got = row.fields[field];
    if (got.status === "update") return `${got.current || "空欄"} → ${got.incoming}`;
    return got.incoming ?? got.current ?? "－";
  };

  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          監督・営業をお客様の情報に反映
          <span className="ml-2 text-sm font-normal text-slate-500">
            顛末書の「どこで」から読んだ値を、PJコードの上8桁が一致するお客様に入れます
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={busy || disabled}
            className={SMALL_BUTTON}
          >
            顧客データを再読み込み
          </button>
          {pending.length > 0 && (
            <button
              type="button"
              onClick={() => void apply(pending)}
              disabled={busy || disabled}
              className={APPLY_BUTTON}
            >
              まとめて反映 ({pending.length}件)
            </button>
          )}
        </div>
      </div>

      {!sync.serverSupported && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-sm text-amber-900">
          このPCのツールは監督・営業に未対応です。~/tenmatsu-dl/ を更新してサーバーを起動し直し、
          python tenmatsu.py backfill --force を実行してください。
        </p>
      )}
      {!listFresh && (
        <p className="mt-2 text-xs text-slate-500">
          前回このブラウザで見た一覧をもとにしています。「一覧を再読み込み」でPCの記録に揃います
        </p>
      )}
      {error && <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-sm text-red-700">{error}</p>}

      <p className="mt-2 text-xs text-slate-500">
        反映できる {counts.update}件 / 一致 {counts.same}件 / 食い違い {counts.conflict}件 /
        お客様が見つからない {counts.unmatched}件
        {sync.skippedNoPj > 0 && ` / PJを読めない顛末書 ${sync.skippedNoPj}件`}
        {sync.skippedNoStaff > 0 && ` / 監督・営業が無い顛末書 ${sync.skippedNoStaff}件`}
      </p>

      {sync.rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          突き合わせられる顛末書がありません (PJコードと監督・営業の両方が要ります)。
        </p>
      ) : (
        <div className="mt-3 max-h-[50vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th className="sticky top-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5">
                  お客様 (PJ上8桁)
                </th>
                <th className="sticky top-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5">
                  監督
                </th>
                <th className="sticky top-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5">
                  営業
                </th>
                <th className="sticky top-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5">
                  状態
                </th>
                <th className="sticky top-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {sync.rows.map((row) => {
                const done = applied.get(row.key);
                // 行の状態は「反映できる」を最優先で出す
                const status: StaffSyncStatus =
                  row.updates.length > 0
                    ? "update"
                    : (STAFF_FIELDS.find(({ key }) => row.fields[key].status === "conflict")
                        ? "conflict"
                        : row.fields.supervisor.status);
                const reasons = STAFF_FIELDS.map(({ key }) => row.fields[key].reason);
                return (
                  <tr key={row.key}>
                    <td className={CELL}>
                      <span className="font-medium">
                        {row.customers.length > 0
                          ? row.customers.map(customerLabel).join(" / ")
                          : "見つかりません"}
                      </span>
                      <p className="text-xs text-slate-500">
                        {row.key}（伝票No. {row.denpyoNos.slice(0, 2).join(", ")}
                        {row.denpyoNos.length > 2 && ` ほか${row.denpyoNos.length - 2}件`}）
                      </p>
                    </td>
                    <td className={CELL}>{fieldText(row, "supervisor")}</td>
                    <td className={CELL}>{fieldText(row, "salesRep")}</td>
                    <td className={CELL}>
                      {done ? (
                        <span className="font-medium text-emerald-700">
                          反映しました ({done}件)
                        </span>
                      ) : (
                        <>
                          <span className={`font-medium ${STATUS_CLASS[status]}`}>
                            {STATUS_LABEL[status]}
                          </span>
                          {reasons.map((reason) => (
                            <p key={reason} className="text-xs text-slate-500">
                              {reason}
                            </p>
                          ))}
                        </>
                      )}
                    </td>
                    <td className={CELL}>
                      {row.updates.length > 0 && !done && (
                        <button
                          type="button"
                          onClick={() => void apply([row])}
                          disabled={busy || disabled}
                          className={APPLY_BUTTON}
                        >
                          反映
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs text-slate-400">
        反映した監督・営業は「手直し」として保存されるので、顧客データを取り込み直しても残ります
        (アフターメンテナンスの顧客カードで確認・取り消しできます)。
        お客様の情報に別の値が入っているときは触りません。同じ現場 (PJ上8桁) で値が
        食い違うときも、どれが正しいか決められないので反映を見送ります。
        顧客データはこのブラウザの中だけにあるため、取り込んだ端末で操作してください。
      </p>
    </section>
  );
}
