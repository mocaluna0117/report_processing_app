/**
 * 利用状況の画面に出す文と数。純関数。
 * （画面のテスト基盤が無いので、ここで固定する）
 */
import { type Metric, RAKURAKU_CODE_LABELS, failureCodeOf } from "@/lib/usage/metrics";
import type { DayCounts, PersonUsage, UsageReport } from "@/lib/usage/summary";

export interface UsageColumn {
  label: string;
  /** 見出しに乗せたときの説明 */
  title: string;
  metrics: readonly Metric[];
  /** 失敗の列（数があれば目立たせる） */
  failure?: boolean;
}

const GEMINI_OK: readonly Metric[] = ["gemini.summary", "gemini.vision", "gemini.kana"];

/** 人ごとの表の列 */
export const SUMMARY_COLUMNS: readonly UsageColumn[] = [
  { label: "定期点検", title: "処理した報告書の件数", metrics: ["teiki"] },
  { label: "アフター", title: "要約した受付メモの件数", metrics: ["after"] },
  { label: "顛末書", title: "楽楽精算から取得した伝票の件数", metrics: ["rk.fetch.tenmatsu"] },
  { label: "専決決裁書", title: "楽楽精算から取得した伝票の件数", metrics: ["rk.fetch.senketsu"] },
  { label: "捺印決裁書", title: "楽楽精算から取得した伝票の件数", metrics: ["rk.fetch.natsuin"] },
  { label: "請求書作成依頼書", title: "楽楽精算から取得した伝票の件数", metrics: ["rk.fetch.seikyu"] },
  { label: "Gemini", title: "Gemini が答えた回数（要約・工事区分・カナ）", metrics: GEMINI_OK },
  { label: "Gemini の失敗", title: "Gemini が失敗して、ルールの処理などに切り替えた回数", metrics: ["gemini.fail"], failure: true },
  { label: "楽楽精算の失敗", title: "ログイン・一覧・取得・添付の失敗（本人が閉じたものは数えない）", metrics: ["rk.fail"], failure: true },
];

/** 日ごとの表の列（人ごとの表より細かい） */
export const DAY_COLUMNS: readonly UsageColumn[] = [
  ...SUMMARY_COLUMNS.slice(0, 6),
  {
    label: "一覧の読み込み",
    title: "楽楽精算の一覧を読み込んだ回数（顛末書・専決・捺印・請求書作成依頼書の合計）",
    metrics: ["rk.scan.tenmatsu", "rk.scan.senketsu", "rk.scan.natsuin", "rk.scan.seikyu"],
  },
  { label: "楽楽精算のログイン", title: "楽楽精算へのログインが通った回数", metrics: ["rk.login"] },
  ...SUMMARY_COLUMNS.slice(6),
  { label: "問い合わせ", title: "送った問い合わせの件数", metrics: ["contact"] },
];

export function sumOf(counts: DayCounts | undefined, metrics: readonly Metric[]): number {
  if (!counts) return 0;
  return metrics.reduce((sum, m) => sum + (counts[m] ?? 0), 0);
}

/** 30日の合計（その人の全部の日） */
export function totalOf(person: PersonUsage, metrics: readonly Metric[]): number {
  return Object.values(person.byDay).reduce((sum, counts) => sum + sumOf(counts, metrics), 0);
}

/** 人ごとの表の1マス。例「12（今日 3）」・数が無ければ「—」 */
export function cellText(total: number, today: number): string {
  if (total === 0) return "—";
  return today > 0 ? `${total}（今日 ${today}）` : String(total);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「20261002」→「10/2（金）」 */
export function dayText(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  return `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/** 時刻を日本時間で。今日なら「今日 14:05」、今年なら「9/30 14:05」、それより前は「2025/12/1 9:00」。null は「—」 */
export function whenText(ms: number | null, nowMs: number): string {
  if (ms === null) return "—";
  const parts = (at: number) => {
    const d = new Date(at + 9 * 3600_000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  };
  const at = parts(ms);
  const now = parts(nowMs);
  const time = `${at.hh}:${String(at.mm).padStart(2, "0")}`;
  if (at.y === now.y && at.m === now.m && at.d === now.d) return `今日 ${time}`;
  if (at.y === now.y) return `${at.m}/${at.d} ${time}`;
  return `${at.y}/${at.m}/${at.d} ${time}`;
}

/** 何か数がある日（新しい順） */
export function activeDays(person: PersonUsage, days: readonly string[]): string[] {
  return days.filter((day) => Object.keys(person.byDay[day] ?? {}).length > 0);
}

export interface FailureRow {
  code: string;
  label: string;
  count: number;
}

/** 楽楽精算の失敗の内訳（30日。多い順） */
export function failureRows(person: PersonUsage): FailureRow[] {
  const counts = new Map<string, number>();
  for (const day of Object.values(person.byDay)) {
    for (const [metric, n] of Object.entries(day) as [Metric, number][]) {
      const code = failureCodeOf(metric);
      if (code) counts.set(code, (counts.get(code) ?? 0) + n);
    }
  }
  return [...counts]
    .map(([code, count]) => ({ code, count, label: RAKURAKU_CODE_LABELS[code as keyof typeof RAKURAKU_CODE_LABELS] ?? code }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export interface GeminiDay {
  day: string;
  ok: number;
  fail: number;
}

/** 全員の Gemini の日ごとの合計（呼んだ日だけ。新しい順）。無料枠は1日ごとに数えられるので、その目安 */
export function geminiDays(report: UsageReport): GeminiDay[] {
  return report.days
    .map((day) => ({
      day,
      ok: report.people.reduce((sum, p) => sum + sumOf(p.byDay[day], GEMINI_OK), 0),
      fail: report.people.reduce((sum, p) => sum + sumOf(p.byDay[day], ["gemini.fail"]), 0),
    }))
    .filter((row) => row.ok + row.fail > 0);
}

export const USAGE_NOTE =
  "直近30日の回数です。残しているのは回数と時刻だけで、お客様の名前や伝票の中身は残していません。定期点検とアフターは、要約を作った件数を数えています。";
