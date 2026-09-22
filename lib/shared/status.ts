/**
 * 共有フォルダーの欄に出す文言と、押せる・押せないの判定。純関数のみ。
 *
 * ★画面（React）のテスト基盤が無いので、**判断と文言はここに置いて** vitest で固定する
 *   （lib/after/flow.ts・lib/tenmatsu/list-view.ts と同じ流儀）。
 * ★共有フォルダーに置くのは手直しと学習だけ。文言でもそれ以上を約束しない。
 */
import type { SharedPending, SyncReport } from "@/lib/shared/sync";

export type SharedFolderState =
  /** このブラウザでは使えない（Safari・Firefox・スマートフォン） */
  | "unsupported"
  /** まだ選んでいない */
  | "none"
  /** 前回のフォルダーはあるが、使う許可を取り直す必要がある */
  | "prompt"
  | "connecting"
  | "connected"
  /** つなげなかった・同期に失敗した */
  | "error";

export interface SharedStatusInput {
  state: SharedFolderState;
  folderName: string | null;
  lastSync: number | null;
  syncing: boolean;
  /** すでに文面になっている失敗（sharedErrorText を通したもの） */
  error: string | null;
  report: SyncReport | null;
  /** ブラウザに保存できるか（復元できるまでは同期しない） */
  canPersist: boolean;
}

export interface SharedStatusView {
  /** 欄の1行目 */
  headline: string;
  /** その下に並べる補足（空なら出さない） */
  notes: string[];
  /** 「このフォルダーへ書き出す」の確認文（要らなければ null） */
  firstWrite: string | null;
  /** 「共有フォルダーと同期」を押せるか */
  canSync: boolean;
  /** 押せない理由・押すと何が起きるか（title に出す） */
  syncReason: string;
  tone: "idle" | "ok" | "warn";
}

export const SHARED_UNSUPPORTED_TEXT =
  "このブラウザでは共有フォルダーを使えません。Windows または macOS の Chrome か Edge で開いてください（Safari・Firefox・スマートフォンでは使えません）。";

export const SHARED_INTRO_TEXT =
  "共有フォルダーを選ぶと、顧客の手直しと学習した書き方をもう1台の端末と共有できます（受付一覧と定期点検の抽出結果は共有しません）。";

/** 日時の表示。★日本時間で出す（端末の時差設定に左右されないため） */
export function formatSyncTime(at: number): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${Number(get("month"))}/${Number(get("day"))} ${get("hour")}:${get("minute")}`;
}

export function lastSyncText(at: number | null): string {
  return at === null ? "まだ同期していません" : `最終同期 ${formatSyncTime(at)}`;
}

const countsText = (pending: SharedPending): string =>
  `手直し ${pending.customers.toLocaleString()}件・学習した書き方 ${(
    pending.examples.inquiry + pending.examples.inspection
  ).toLocaleString()}件`;

/**
 * まだ何も置かれていないフォルダーを選んだときの確認文。
 * ★選び間違えたフォルダーへ黙って書き出さないために、必ずボタンで確かめてもらう。
 */
export function firstWriteText(folderName: string | null, pending: SharedPending): string {
  const where = folderName ? `「${folderName}」` : "このフォルダー";
  return `${where}にはまだ共有データがありません。この端末の ${countsText(pending)} を書き出します。`;
}

/** 同期できたときの結果 */
export function syncResultText(report: SyncReport): string {
  const learned = report.examples.inquiry.count + report.examples.inspection.count;
  return `手直し ${report.pending.customers.toLocaleString()}件・学習した書き方 ${learned.toLocaleString()}件を共有しています（この端末に取り込んだ手直し ${report.customers.applied.toLocaleString()}件）。`;
}

/**
 * この端末の顧客データに見つからなかった手直しの案内。
 * ★「捨てた」と誤解されないよう、結び付け方まで書く。
 */
export function unmatchedText(count: number): string | null {
  if (count <= 0) return null;
  return `この端末の顧客データに見つからない手直しが ${count.toLocaleString()}件あります（相手と同じ顧客ファイルを取り込むと結び付きます。共有フォルダーからは消えません）。`;
}

/**
 * 「学習した書き方を消去」の確認文。
 * ★共有フォルダーにつないでいると**相手の端末からも消える**ので、それを先に書く。
 */
export function clearExamplesConfirmText(count: number, shared: boolean): string {
  const head = `学習した書き方 ${count.toLocaleString()}件 をすべて消去します。`;
  return shared
    ? `${head}\n★共有フォルダーにつないでいるため、次の同期で相手の端末からも消えます。\nよろしいですか？`
    : `${head}よろしいですか？`;
}

export function sharedStatus(input: SharedStatusInput): SharedStatusView {
  const { state, folderName, report } = input;
  const notes: string[] = [];
  let tone: SharedStatusView["tone"] = "idle";

  const headline = (() => {
    switch (state) {
      case "unsupported":
        return SHARED_UNSUPPORTED_TEXT;
      case "none":
        return SHARED_INTRO_TEXT;
      case "prompt":
        return `前回の共有フォルダー: ${folderName ?? "（名前を読めません）"}`;
      case "connecting":
        return "共有フォルダーにつないでいます…";
      case "connected":
        return `共有フォルダー: ${folderName ?? "（名前を読めません）"}`;
      case "error":
        return folderName
          ? `共有フォルダー「${folderName}」を使えませんでした`
          : "共有フォルダーを使えませんでした";
    }
  })();

  if (state === "prompt" || state === "connected") notes.push(lastSyncText(input.lastSync));
  if (input.error) {
    notes.push(input.error);
    tone = "warn";
  }

  const firstWrite =
    state === "connected" && report?.awaitingFirstWrite ? firstWriteText(folderName, report.pending) : null;

  if (report && !report.awaitingFirstWrite) {
    if (state === "connected") notes.push(syncResultText(report));
    const unmatched = unmatchedText(report.customers.unmatched);
    if (unmatched) {
      notes.push(unmatched);
      if (tone !== "warn") tone = "warn";
    }
    for (const failure of report.failures) {
      notes.push(`${failure.label}: ${failure.message}`);
      tone = "warn";
    }
    if (tone === "idle" && state === "connected") tone = "ok";
  }

  const syncReason = (() => {
    if (state === "unsupported") return SHARED_UNSUPPORTED_TEXT;
    if (state === "none") return "先に「共有フォルダーを選ぶ」を押してください";
    if (state === "prompt") return "先に「共有フォルダーにつなぐ」を押してください";
    if (state === "connecting") return "共有フォルダーにつないでいます";
    if (state === "error") return "共有フォルダーにつなぎ直してから押せます";
    if (!input.canPersist) return "このタブでは保存を停止しているため同期できません";
    if (input.syncing) return "同期しています";
    return "相手の変更を取り込み、この端末の手直しと学習した書き方を書き出します";
  })();

  return {
    headline,
    notes,
    firstWrite,
    canSync: state === "connected" && !input.syncing && input.canPersist,
    syncReason,
    tone,
  };
}
