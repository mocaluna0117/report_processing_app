import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { StoreUnavailableError } from "@/lib/account/kv";
import { accountPageState } from "@/lib/account/page-state";
import { accountStoreFor, currentAuthConfig, kvFor } from "@/lib/account/runtime";
import { loadUsageReport } from "@/lib/account/usage-admin";
import { SESSION_COOKIE } from "@/lib/auth";
import type { UsageReport } from "@/lib/usage/summary";
import {
  DAY_COLUMNS,
  SUMMARY_COLUMNS,
  USAGE_NOTE,
  activeDays,
  cellText,
  dayText,
  failureRows,
  geminiDays,
  sumOf,
  totalOf,
  whenText,
} from "@/lib/usage/view";

export const metadata: Metadata = { title: "利用状況 — Folio" };
export const dynamic = "force-dynamic";

const NOTICE = "rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600";
const TH = "whitespace-nowrap border-b border-slate-200 px-3 py-2 font-medium";
const TD = "whitespace-nowrap border-b border-slate-100 px-3 py-2";

/**
 * 人ごとの利用状況（管理者だけ）。
 * ★印の中身だけを信じず、Redis で「今も管理者で、止められていない」ことを確かめてから読む（accountPageState）。
 * ★日ごとの表は details で開く（画面のプログラムを持たない）。
 */
export default async function UsagePage() {
  const config = currentAuthConfig();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const state = await accountPageState(config, token, accountStoreFor, Math.floor(Date.now() / 1000));

  let body: ReactNode;
  if (state.kind === "off" || config.kind !== "accounts") {
    body = <p className={NOTICE}>この環境では、一人ずつのアカウントを使っていません（手元の開発）。</p>;
  } else if (state.kind === "expired") {
    body = (
      <p className={NOTICE}>
        ログインが切れました。
        <Link href="/login?next=%2Faccount%2Fusage" className="ml-1 font-medium text-blue-700 underline">
          もう一度ログイン
        </Link>
        してください。
      </p>
    );
  } else if (state.kind === "unavailable") {
    body = unavailable;
  } else if (state.record.role !== "admin" || state.forced) {
    body = <p className={NOTICE}>管理者だけが使えます。</p>;
  } else {
    const nowMs = Date.now();
    let report: UsageReport | null = null;
    try {
      report = await loadUsageReport({ store: accountStoreFor(config), kv: kvFor(config) }, nowMs);
    } catch (e) {
      if (!(e instanceof StoreUnavailableError)) throw e;
    }
    body = report ? <UsageTables report={report} nowMs={nowMs} /> : unavailable;
  }

  return (
    <main className="mt-8">
      <h1 className="text-xl font-bold text-slate-900">利用状況</h1>
      <p className="mt-1 text-sm text-slate-600">{USAGE_NOTE}</p>
      <div className="mt-6">{body}</div>
      <p className="mt-6 text-sm">
        <Link href="/account" className="font-medium text-blue-700 underline">
          アカウントの画面へ戻る
        </Link>
      </p>
    </main>
  );
}

const unavailable = (
  <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
    いまアカウントの置き場所に届きません。少し待ってから読み込み直してください。
  </p>
);

function UsageTables({ report, nowMs }: { report: UsageReport; nowMs: number }) {
  const gemini = geminiDays(report);
  return (
    <>
      <section>
        <h2 className="text-lg font-semibold">人ごと（直近30日の合計）</h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className={TH}>表示名</th>
                <th className={TH}>最終ログイン</th>
                <th className={TH}>最後に使った</th>
                {SUMMARY_COLUMNS.map((c) => (
                  <th key={c.label} className={`${TH} text-right`} title={c.title}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.people.map((person) => (
                <tr key={person.id} className={person.disabled ? "text-slate-400" : undefined}>
                  <td className={`${TD} font-medium`}>
                    {person.name}
                    <span className="ml-1.5 font-mono text-xs font-normal text-slate-500">{person.id}</span>
                    {person.disabled && <span className="ml-1.5 text-xs">（止めています）</span>}
                  </td>
                  <td className={TD}>{whenText(person.loginAt, nowMs)}</td>
                  <td className={TD}>{whenText(person.lastUsedAt, nowMs)}</td>
                  {SUMMARY_COLUMNS.map((c) => {
                    const total = totalOf(person, c.metrics);
                    return (
                      <td
                        key={c.label}
                        className={`${TD} text-right tabular-nums ${c.failure && total > 0 ? "font-medium text-red-700" : ""}`}
                      >
                        {cellText(total, sumOf(person.byDay[report.today], c.metrics))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">日ごと</h2>
        <p className="mt-1 text-sm text-slate-600">名前を押すと、その人の日ごとの回数が開きます（回数のある日だけ）。</p>
        <div className="mt-2 space-y-2">
          {report.people.map((person) => (
            <PersonDays key={person.id} person={person} days={report.days} />
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Gemini（全員の合計）</h2>
        <p className="mt-1 text-sm text-slate-600">無料枠は1日ごとに数えられます。その日の残りの目安にしてください。</p>
        {gemini.length === 0 ? (
          <p className={`${NOTICE} mt-2`}>直近30日に Gemini を使った記録はありません。</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white sm:max-w-md">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className={TH}>日付</th>
                  <th className={`${TH} text-right`}>答えた回数</th>
                  <th className={`${TH} text-right`}>失敗</th>
                </tr>
              </thead>
              <tbody>
                {gemini.map((row) => (
                  <tr key={row.day}>
                    <td className={TD}>{dayText(row.day)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{row.ok}</td>
                    <td className={`${TD} text-right tabular-nums ${row.fail > 0 ? "text-red-700" : ""}`}>{row.fail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function PersonDays({ person, days }: { person: UsageReport["people"][number]; days: readonly string[] }) {
  const active = activeDays(person, days);
  const failures = failureRows(person);
  return (
    <details className="rounded-lg border border-slate-200 bg-white">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
        {person.name}
        <span className="ml-2 text-xs font-normal text-slate-500">
          {active.length === 0 ? "直近30日の記録なし" : `${active.length}日分`}
        </span>
      </summary>
      {active.length > 0 && (
        <div className="border-t border-slate-200 px-4 py-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className={TH}>日付</th>
                  {DAY_COLUMNS.map((c) => (
                    <th key={c.label} className={`${TH} text-right`} title={c.title}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.map((day) => (
                  <tr key={day}>
                    <td className={TD}>{dayText(day)}</td>
                    {DAY_COLUMNS.map((c) => {
                      const n = sumOf(person.byDay[day], c.metrics);
                      return (
                        <td key={c.label} className={`${TD} text-right tabular-nums ${c.failure && n > 0 ? "text-red-700" : ""}`}>
                          {n || "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {failures.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-semibold">楽楽精算の失敗の内訳（30日）</h3>
              <ul className="mt-1 space-y-0.5 text-sm">
                {failures.map((f) => (
                  <li key={f.code}>
                    {f.label}
                    <span className="ml-1.5 font-mono text-xs text-slate-500">{f.code}</span>
                    <span className="ml-2 tabular-nums">{f.count}回</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
