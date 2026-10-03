/**
 * 支出報告書の画面を使える人（2026-10-03: 1人目のアカウント「kimura」だけ）。
 *
 * ★守るのはページ（app/shishutsu/page.tsx が Redis のアカウントで確かめる）。
 *   タブを出すかどうか（components/mode-nav.tsx）は見た目だけで、印の中身は書き換えられる。
 * ★支出報告書は顛末書の金額をまとめたもの。ほかの人に見せる・使わせるときは、ここに足す。
 */
export const EXPENSE_REPORT_ACCOUNT_IDS: readonly string[] = ["kimura"];

export const EXPENSE_REPORT_PATH = "/shishutsu";
export const EXPENSE_REPORT_LABEL = "支出報告書";

export function canUseExpenseReport(id: string | null | undefined): boolean {
  return typeof id === "string" && EXPENSE_REPORT_ACCOUNT_IDS.includes(id);
}
