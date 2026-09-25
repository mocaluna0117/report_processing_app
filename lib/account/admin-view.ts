/**
 * 管理の欄に出す文。純関数（画面のテスト基盤が無いので、ここで固定する）。
 */
import { displayNameProblem, loginIdProblem, normalizeLoginId } from "@/lib/account/policy";
import type { AccountSummary } from "@/lib/account/record";

/** 日時の表示（日本時間） */
export function formatJstDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${Number(get("month"))}/${Number(get("day"))} ${get("hour")}:${get("minute")}`;
}

/** 状態の表示 */
export function accountStatusText(account: AccountSummary, nowMs: number): { text: string; tone: "ok" | "warn" | "off" } {
  if (account.disabled) return { text: "止めています", tone: "off" };
  if (account.mustChange) {
    if (account.tempExpiresAt !== null && account.tempExpiresAt <= nowMs) {
      return { text: "仮のパスワードの期限切れ（発行し直してください）", tone: "warn" };
    }
    const until = account.tempExpiresAt !== null ? `（${formatJstDate(account.tempExpiresAt)}まで）` : "";
    return { text: `仮のパスワード${until}。本人がまだパスワードを決めていません`, tone: "warn" };
  }
  return { text: "使えます", tone: "ok" };
}

export function roleText(account: AccountSummary): string {
  return account.role === "admin" ? "管理者" : "利用者";
}

/** 押す前に確かめる文（window.confirm に出す） */
export function adminConfirmText(action: "reset" | "disable" | "delete", account: AccountSummary): string {
  const who = `「${account.name}」（ログインID: ${account.id}）`;
  switch (action) {
    case "reset":
      return `${who}に新しい仮のパスワードを発行します。\n今のパスワードとログインは使えなくなります。よろしいですか？`;
    case "disable":
      return `${who}を止めます。\n次に画面を開いたとき（遅くとも5分以内）にログインが切れ、入れなくなります（あとで再開できます）。よろしいですか？`;
    case "delete":
      return `${who}を消します。\n元に戻せません（同じIDで作り直すことはできます）。よろしいですか？`;
  }
}

/** 追加の欄の、押せない理由（無ければ null） */
export function createBlocker(input: { id: string; name: string; busy: boolean; existing: readonly string[] }): string | null {
  if (input.busy) return "送っています";
  const id = normalizeLoginId(input.id);
  if (id === "") return "ログインIDを入れてください（例: 名字のローマ字）";
  const idProblem = loginIdProblem(id);
  if (idProblem) return idProblem;
  if (input.existing.includes(id)) return "そのログインIDはもう使われています";
  return displayNameProblem(input.name);
}
