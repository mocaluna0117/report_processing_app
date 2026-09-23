/**
 * 共有フォルダーの欄に出す文言と、押せる・押せないの判定。純関数のみ。
 *
 * ★画面（React）のテスト基盤が無いので、**判断と文言はここに置いて** vitest で固定する
 *   （lib/after/flow.ts・lib/tenmatsu/list-view.ts と同じ流儀）。
 * ★共有フォルダーに置くのは手直しと学習だけ。文言でもそれ以上を約束しない。
 */
import type { SharedPending, SyncReport } from "@/lib/shared/sync";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";

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
  /**
   * 共有フォルダーの顧客ファイルを取り込むと件数が減るので、確かめてもらう文（要らなければ null）。
   * ★ボタンを押すまで入れ替えない。
   */
  ledgerReplace: string | null;
  /** 「共有フォルダーと同期」を押せるか */
  canSync: boolean;
  /** 押せない理由・押すと何が起きるか（title に出す） */
  syncReason: string;
  tone: "idle" | "ok" | "warn";
}

export const SHARED_UNSUPPORTED_TEXT =
  "このブラウザでは共有フォルダーを使えません。Windows または macOS の Chrome か Edge で開いてください（Safari・Firefox・スマートフォンでは使えません）。";

export const SHARED_INTRO_TEXT =
  "共有フォルダーを選ぶと、顧客データ（台帳と手直し）と学習した書き方をもう1台の端末と共有できます（受付一覧と定期点検の抽出結果は共有しません）。";

/**
 * ヘッダーから開くモーダルの1行目。
 * ★つながりは Folio 全体で1つ。どの画面が自分から同期するかを先に言う（専決・捺印ではしない）。
 */
export const SHARED_DIALOG_LEAD =
  "つながりは Folio 全体で1つです。定期点検・アフターメンテナンス・顛末書は、開いたときに相手の変更を取り込み、直したら書き出します（専決決裁書・捺印決裁書では同期しません）。";

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
  return (
    `顧客データ ${report.customerLedger.count.toLocaleString()}件・` +
    `手直し ${report.pending.customers.toLocaleString()}件・` +
    `学習した書き方 ${learned.toLocaleString()}件を共有しています` +
    `（この端末に取り込んだ手直し ${report.customers.applied.toLocaleString()}件）。`
  );
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

  // 共有フォルダーの顧客ファイルの結果は、書き出しの確認中でも出す（読むだけなので先に動いている）
  if (report) {
    if (report.customerLedger.applied > 0) {
      notes.push(
        `共有フォルダーから顧客データを ${report.customerLedger.applied.toLocaleString()}件 取り込みました。`,
      );
    }
    for (const line of report.ledger.imported) notes.push(line);
    for (const skipped of report.ledger.skipped) {
      notes.push(`「${skipped.file}」は顧客データとして読めないので飛ばしました（${skipped.message}）`);
    }
    // ★どれを使うか決められないときは、取り込まずに知らせる（黙って片方を選ばない）
    for (const conflict of report.ledger.conflicts) {
      notes.push(conflict);
      tone = "warn";
    }
  }
  const ledgerReplace =
    state === "connected" && report && report.ledger.pending.length > 0
      ? `${report.ledger.pending.map((p) => p.text).join(" ")}よろしければ「共有フォルダーの顧客ファイルを取り込む」を押してください。`
      : null;
  if (ledgerReplace && tone !== "warn") tone = "warn";

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
    ledgerReplace,
    canSync: state === "connected" && !input.syncing && input.canPersist,
    syncReason,
    tone,
  };
}

/**
 * その画面が共有フォルダーのデータ（顧客データ・手直し・学習）を使うか。
 * 定期点検（引渡日・学習）・アフター・顛末書（監督・営業）は使う。専決決裁書・捺印決裁書は使わない。
 * ★使う画面だけが、開いたときに自動で同期する。ヘッダーの表示も、使う画面でだけ目立たせる。
 */
export function usesSharedFolder(pathname: string): boolean {
  if (pathname === "/" || pathname === "/after") return true;
  return DOC_KINDS.some((kind) => kind.route === pathname && kind.showStaffSync);
}

/**
 * 同期でこの端末の顧客データが変わったか（画面の顧客の写しを読み直すか）。
 * ★手直し・台帳の JSON・xlsx の取り込み、どれで変わっても読み直す。
 */
export function changedCustomers(report: SyncReport): boolean {
  return (
    report.customers.applied > 0 || report.customerLedger.applied > 0 || report.ledger.imported.length > 0
  );
}

export type SharedChipTone =
  /** まだ分からない（サーバーで描いた直後）・つないでいる途中。静かに出す */
  | "unknown"
  /** つながっていない・確かめてほしいことがある。**その画面で使う**ので目立たせる */
  | "alert"
  /** つながっていない。ただしその画面では使わないので静かに出す */
  | "off"
  | "on";

export interface SharedChipView {
  text: string;
  tone: SharedChipTone;
  title: string;
  /** 状態の点を出すか（読み上げには出さない飾り） */
  dot: boolean;
}

/** ヘッダーの共有フォルダーの表示を押したときに何が起きるか（title の後ろに付ける） */
const OPEN_HINT = "押すと共有フォルダーの欄が開きます";

/**
 * ヘッダーに出す共有フォルダーの状態。
 *
 * ★`known` が false のあいだ（サーバーで描いた直後）は「共有フォルダー」とだけ出す。
 * ★目立たせるのは**共有フォルダーのデータを使う画面**（usesSharedFolder）だけ。
 *   専決決裁書・捺印決裁書では使わないので、そこで気を引くと邪魔なだけになる。
 * ★つながっていても、確かめてもらうこと（初回の書き出し・顧客ファイルの入れ替え・失敗）が
 *   あれば目立たせる。欄が画面に無いタブでも気づけるように。
 */
export function sharedChip(input: SharedStatusInput & { known: boolean; usesShared: boolean }): SharedChipView {
  const { state, folderName, usesShared } = input;
  const name = folderName ? `「${folderName}」` : "前回のフォルダー";
  const unlinked = (text: string, title: string): SharedChipView => ({
    text,
    tone: usesShared ? "alert" : "off",
    title: `${title}。${OPEN_HINT}`,
    dot: usesShared,
  });
  if (!input.known) {
    return { text: "共有フォルダー", tone: "unknown", title: "共有フォルダー（Box など）とのつながり", dot: false };
  }
  switch (state) {
    case "unsupported":
      return { text: "共有フォルダー: 使えません", tone: "off", title: SHARED_UNSUPPORTED_TEXT, dot: false };
    case "none":
      return unlinked(
        "共有フォルダー: 未設定",
        "まだ共有フォルダーを選んでいません。この端末で変えた顧客データや学習は、もう1台に伝わりません",
      );
    case "prompt":
      return unlinked(
        "共有フォルダー: 未接続",
        `${name}にまだつないでいません。つなぐまで、相手の変更は届かず、この端末の変更も出ていきません`,
      );
    case "connecting":
      return { text: "共有フォルダー: つないでいます…", tone: "unknown", title: `${name}につないでいます`, dot: false };
    case "error":
      return unlinked("共有フォルダー: つなげません", input.error ?? `${name}を使えませんでした`);
    case "connected":
      break;
  }
  if (input.syncing) {
    return { text: "共有フォルダー: 同期中…", tone: "on", title: `${name}と同期しています`, dot: true };
  }
  const view = sharedStatus(input);
  if (view.firstWrite || view.ledgerReplace || view.tone === "warn") {
    return {
      text: "共有フォルダー: 確認してください",
      tone: usesShared ? "alert" : "off",
      title: `${name}について確かめてほしいことがあります。${OPEN_HINT}`,
      dot: usesShared,
    };
  }
  return {
    text: "共有フォルダー: 接続済み",
    tone: "on",
    title: `${name}とつながっています（${lastSyncText(input.lastSync)}）。${OPEN_HINT}`,
    dot: true,
  };
}
