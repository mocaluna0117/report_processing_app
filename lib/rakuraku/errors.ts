import "server-only";

/**
 * 楽楽精算の操作で起きる失敗の符号。
 *
 * ★ 「権限が無い」と「画面が変わった」を必ず区別する。
 *   現行の Python ツールはここを分けておらず、権限が理由でも
 *   「config.json の list_url を直してください」と案内してしまい、
 *   利用者を誤った対処へ導いていた。
 */
export type RakurakuCode =
  // 入口
  | "DISABLED"
  | "PREVIEW_BLOCKED"
  | "BAD_REQUEST"
  | "FORBIDDEN_ORIGIN"
  | "NO_PASSWORD"
  // ブラウザ
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_BUSY"
  | "TENANT_UNREACHABLE"
  // ログイン
  | "LOGIN_FORM_NOT_FOUND"
  | "LOGIN_FAILED"
  | "LOGIN_COOLDOWN"
  | "SESSION_EXPIRED"
  // 部門と権限
  | "DEPT_NOT_AVAILABLE"
  | "DEPT_SELECT_MISSING"
  | "LIST_NOT_PERMITTED"
  | "MENU_NOT_FOUND"
  | "MENU_AMBIGUOUS"
  // 取得
  | "LIST_NOT_FOUND"
  | "DETAIL_NOT_FOUND"
  | "BODY_PDF_FAILED"
  | "ATTACHMENT_FAILED"
  | "ATTACHMENT_MISMATCH"
  | "TIME_BUDGET_EXCEEDED"
  | "INTERNAL";

export class RakurakuError extends Error {
  constructor(
    readonly code: RakurakuCode,
    message: string,
    /** その伝票だけ見送れば続けられるか */
    readonly retryable = false,
    /** ログインし直しが要るか */
    readonly sessionLost = false,
  ) {
    super(message);
    this.name = "RakurakuError";
  }
}

/** 部門が選べないときの文。選べるものを添えて、利用者が自分で判断できるようにする */
export function departmentNotAvailableText(wanted: string, available: { label: string }[]): string {
  const list = available.map((d) => d.label).join(" / ");
  return list
    ? `このアカウントでは「${wanted}」を選べません。選べるのは ${list} です`
    : `このアカウントでは部門を選べません（選択肢が空でした）`;
}

/** 一覧に着いたはずなのに一覧表が無いときの文 */
export function listNotPermittedText(label: string): string {
  return `このアカウントでは${label}の一覧を開けません（閲覧権限が無い可能性があります）`;
}

/** メニューが見つからないときの文。★設定の誤りだけを疑わせない */
export function menuNotFoundText(label: string): string {
  return `このアカウントでは${label}のメニューが出ません（閲覧権限が無いか、楽楽精算の画面が変わった可能性があります）`;
}

/** 部門のプルダウンそのものが無いときの文 */
export const DEPT_SELECT_MISSING_TEXT =
  "このアカウントには部門の切り替えがありません（部門内検索の権限が無い可能性があります）";
