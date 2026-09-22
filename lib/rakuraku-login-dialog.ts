"use client";

/**
 * 楽楽精算のログインを、Folio 全体で1か所（モーダル）から行うための状態と規則。
 *
 * ★**ここは「開く・閉じる」だけを決める。ログインそのものは絶対に行わない。**
 *   楽楽精算は続けて失敗するとアカウントがロックされるので、Folio は
 *   利用者がボタンを押したときにだけ1回試す（lib/rakuraku/login.ts の規則）。
 * ★状態の持ち方は lib/help-dialog.ts と同じ（モジュールの変数＋listener）。
 *   画面（React）のテスト基盤が無いので、**判断と文言はここの純関数に置いて** vitest で固定する。
 * ★ログインの中身（パスワード・封じたトークン）は持たない。それは
 *   lib/tenmatsu/local/session.ts の役目。ここは「いま開いているか」だけを持つ。
 */
import { getSessionToken } from "@/lib/tenmatsu/local/session";
import type { DocKindId } from "@/lib/tenmatsu/kinds";

/** なぜ開いたか。自動で閉じてよいか・出す文言が変わる */
export type LoginDialogReason =
  /** 顛末書系の画面を開いたら未ログインだった */
  | "auto"
  /** 利用者が自分で開いた（ヘッダーの表示・画面の「ログイン」） */
  | "manual"
  /** 作業の途中でログインが切れた */
  | "session-lost";

export interface LoginDialogState {
  open: boolean;
  reason: LoginDialogReason | null;
  /** どの画面から開いたか（文言に使う）。定期点検・アフターからは null */
  kind: DocKindId | null;
}

/**
 * 「このタブではもう自動で出さない」の印（sessionStorage。タブを閉じると消える）。
 * ★取得済みの一覧を見るだけの人を、画面を開くたびに邪魔しないために持つ。
 * ★scripts/help-shots/seed.ts も同じ文字列を直に書いている（あちらはブラウザの中で動くので
 *   読み込めない）。tests/rakuraku-login-dialog.test.ts が食い違いを見張る。
 */
export const LOGIN_DISMISSED_KEY = "folio:rakuraku:login-dismissed";

/**
 * ヘッダーの楽楽精算の表示に付ける目印。
 * ★手順バーの②と「→ ログイン」の行き先。入力欄は画面から無くしてモーダルに移したので、
 *   行き先は**どの画面にもあるヘッダーの表示**になる（押すとモーダルも開く）。
 */
export const RAKURAKU_CHIP_ID = "rakuraku-login";

let state: LoginDialogState = { open: false, reason: null, kind: null };
const listeners = new Set<(state: LoginDialogState) => void>();

const notify = () => {
  for (const listener of listeners) listener(state);
};

/** sessionStorage を使えないとき（サーバーで描くとき・ブラウザが禁止しているとき）は null */
function tabStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function getLoginDialogState(): LoginDialogState {
  return state;
}

export function subscribeLoginDialog(listener: (state: LoginDialogState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openLoginDialog(reason: LoginDialogReason, kind: DocKindId | null = null): void {
  state = { open: true, reason, kind };
  notify();
}

/**
 * 閉じる。
 * ★ログインしないまま閉じたときだけ「このタブでは自動で出さない」を覚える
 *   （ログインできて閉じたのなら、次にログインが切れたときは出してよい）。
 */
export function closeLoginDialog(): void {
  if (getSessionToken() === null) markLoginDismissedInTab();
  state = { open: false, reason: null, kind: null };
  notify();
}

export function isLoginDismissedInTab(): boolean {
  try {
    return tabStorage()?.getItem(LOGIN_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 自分でログアウトしたときにも押す（押した直後にまた出てくると鬱陶しいため） */
export function markLoginDismissedInTab(): void {
  try {
    tabStorage()?.setItem(LOGIN_DISMISSED_KEY, "1");
  } catch {
    // 覚えられなくても、出しすぎるだけで害はない
  }
}

/** ログインできたら消す（次にログインが切れたら、また出してよい） */
export function clearLoginDismissal(): void {
  try {
    tabStorage()?.removeItem(LOGIN_DISMISSED_KEY);
  } catch {
    // 消せなくても、出さないだけ
  }
}

/** テスト用 */
export function resetLoginDialogForTests(): void {
  state = { open: false, reason: null, kind: null };
  listeners.clear();
}

// ---------------------------------------------------------------------------
// 規則（純関数）
// ---------------------------------------------------------------------------

export interface AutoOpenInput {
  /** 楽楽精算を使う画面なら種類。★定期点検・アフターは null */
  kind: DocKindId | null;
  loggedIn: boolean;
  dismissedInTab: boolean;
  alreadyOpen: boolean;
}

/**
 * 画面を開いた直後に、自分から出すか。
 * ★`kind` が null（定期点検・アフター）は**常に出さない**。この2画面は楽楽精算を使わないので、
 *   顧客データだけを使う日にログインを求めると、ログインの回数だけが増える。
 */
export function shouldAutoOpenLogin(input: AutoOpenInput): boolean {
  if (input.kind === null) return false;
  return !input.loggedIn && !input.dismissedInTab && !input.alreadyOpen;
}

export interface SessionLostInput {
  /** どこで切れたか */
  during: "departments" | "run" | "run-end";
  /** パスワードがまだメモリにあるか */
  hasPassword: boolean;
}

/**
 * 作業の途中でログインが切れたときに出すか。
 * ★取得の最中（run）は、パスワードがメモリにあれば job.ts が**この実行の中で1回だけ**
 *   入り直すので、邪魔をしない。入り直せない（パスワードが無い）ときだけ出す。
 */
export function shouldPromptOnSessionLost(input: SessionLostInput): boolean {
  if (input.during === "run") return !input.hasPassword;
  return true;
}

/**
 * 別の場所でログインできたときに、自分で閉じるか。
 * ★自分で開いたもの（manual）は閉じない。ログイン中の表示を見に来ただけかもしれないため。
 */
export function shouldAutoCloseLogin(input: {
  open: boolean;
  reason: LoginDialogReason | null;
  loggedIn: boolean;
}): boolean {
  return input.open && input.loggedIn && input.reason !== "manual";
}

export type ChipTone =
  /** まだ分からない（サーバーで描いた直後）。静かに出す */
  | "unknown"
  /** 未ログイン。**その画面で要る**ので目立たせる */
  | "alert"
  /** 未ログイン。ただしその画面では使わないので静かに出す */
  | "off"
  | "on";

export interface ChipView {
  text: string;
  tone: ChipTone;
  title: string;
  /** 状態の点を出すか（読み上げには出さない飾り） */
  dot: boolean;
}

/**
 * ヘッダーに出す楽楽精算の状態。
 *
 * ★`known` が false のあいだ（サーバーで描いた直後）は「楽楽精算」とだけ出す。
 *   ここで sessionStorage を読むと、サーバーの描画と食い違う。
 * ★未ログインを目立たせるのは**楽楽精算を使う画面**（顛末書・専決決裁書・捺印決裁書）だけ。
 *   定期点検・アフターでは使わないので、そこで気を引くと邪魔なだけになる。
 */
export function rakurakuChip(input: {
  known: boolean;
  loggedIn: boolean;
  userId: string | null;
  /** いま見ているのが楽楽精算を使う画面か（顛末書系なら true） */
  onDocPage: boolean;
}): ChipView {
  if (!input.known) {
    return { text: "楽楽精算", tone: "unknown", title: "楽楽精算のログイン", dot: false };
  }
  if (!input.loggedIn) {
    return {
      text: "楽楽精算: 未ログイン",
      tone: input.onDocPage ? "alert" : "off",
      title: input.onDocPage
        ? "この画面の取得には楽楽精算のログインが要ります。押すとログインの画面が開きます"
        : "押すと楽楽精算のログインの画面が開きます（顛末書・専決決裁書・捺印決裁書で使います）",
      dot: input.onDocPage,
    };
  }
  return {
    text: "楽楽精算: ログイン中",
    tone: "on",
    title: input.userId
      ? `ID: ${input.userId}。押すとログインの画面が開きます（ログアウトもできます）`
      : "押すとログインの画面が開きます（ログアウトもできます）",
    dot: true,
  };
}

/**
 * ヘッダーの「ログアウト」の文言。
 * ★楽楽精算のログアウト（「ログアウト (パスワードを忘れる)」）と取り違えられていたので、
 *   どちらのログアウトかを名前に入れる。
 */
export const FOLIO_LOGOUT_LABEL = "Folio からログアウト";
export const FOLIO_LOGOUT_TITLE =
  "Folio 自体のログインを解除します（楽楽精算のログアウトは「楽楽精算」の表示から）。共有の端末では作業後に押してください";

/** 押す前に知っておくこと。★「ロック」と「やり直しません」を落とさない */
export const LOGIN_RULE_TEXT =
  "パスワードは保存しません。楽楽精算は続けて失敗するとアカウントがロックされるので、失敗しても自動でやり直しません。";

export interface LoginDialogCopy {
  title: string;
  lead: string;
}

/** モーダルの見出しと前書き（なぜ開いたかで変える） */
export function loginDialogCopy(
  reason: LoginDialogReason | null,
  kindLabel: string | null,
): LoginDialogCopy {
  if (reason === "session-lost") {
    return {
      title: "楽楽精算のログインが切れました",
      lead: "もう一度パスワードを入れて「ログイン」を押してください。自動ではログインし直しません。",
    };
  }
  if (reason === "auto") {
    return {
      title: "楽楽精算にログイン",
      lead: `${kindLabel ?? "書類"}を取得するには、ご自分の楽楽精算のログインが要ります。閉じても、この画面の「ログイン」からいつでも開けます。`,
    };
  }
  return {
    title: "楽楽精算にログイン",
    lead: "顛末書・専決決裁書・捺印決裁書の取得に使います。ログインは3つの画面で共通です。",
  };
}
