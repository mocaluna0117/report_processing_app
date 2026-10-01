import "server-only";
import { BROWSER_GONE_SIGNS, type CrashSigns, crashSigns, failureSign } from "./failure";
import type { DepartmentOption, RakurakuCode } from "./protocol";

export type { RakurakuCode } from "./protocol";

/**
 * 楽楽精算の操作で起きる失敗。符号の一覧は `protocol.ts`（ブラウザと共有するため）。
 *
 * ★ 「権限が無い」と「画面が変わった」を必ず区別する。
 *   現行の Python ツールはここを分けておらず、権限が理由でも
 *   「config.json の list_url を直してください」と案内してしまい、
 *   利用者を誤った対処へ導いていた。
 */
export interface RakurakuErrorOptions {
  /** その伝票だけ見送れば続けられるか */
  retryable?: boolean;
  /** ログインし直しが要るか */
  sessionLost?: boolean;
  /** 部門が選べなかったとき、このアカウントで選べるもの */
  available?: DepartmentOption[];
  /** ブラウザの失敗の符号（failure.ts の failureSign）。ログに残して原因を見分ける */
  detail?: string;
  /** ブラウザが落ちたときの手がかり（failure.ts の crashSigns）。ログにだけ残す */
  crash?: CrashSigns;
}

export class RakurakuError extends Error {
  readonly retryable: boolean;
  readonly sessionLost: boolean;
  readonly available?: DepartmentOption[];
  readonly detail?: string;
  readonly crash?: CrashSigns;

  constructor(
    readonly code: RakurakuCode,
    message: string,
    options: RakurakuErrorOptions = {},
  ) {
    super(message);
    this.name = "RakurakuError";
    this.retryable = options.retryable ?? false;
    this.sessionLost = options.sessionLost ?? false;
    if (options.available) this.available = options.available;
    if (options.detail) this.detail = options.detail;
    if (options.crash && Object.keys(options.crash).length > 0) this.crash = options.crash;
  }
}

/** 「こちらのブラウザが落ちた」失敗か（browserGoneError か、openHome などが同じ符号で投げたもの） */
export function isBrowserGoneError(error: unknown): error is RakurakuError {
  return (
    error instanceof RakurakuError &&
    error.code === "TENANT_UNREACHABLE" &&
    error.detail !== undefined &&
    BROWSER_GONE_SIGNS.has(error.detail)
  );
}

/**
 * 楽楽精算を開いている**こちらのブラウザ**が途中で落ちた。
 *
 * ★符号は TENANT_UNREACHABLE のまま（やり直してよい失敗。画面の扱いを変えない）にして、文で区別する。
 *   以前は「楽楽精算の画面に繋がりませんでした」と出していたが、楽楽精算は落ちていない
 *   （2026-10-01。同じ時間に、ログインと部門の読み込みは毎回通っていた）。
 */
export function browserGoneError(error?: unknown): RakurakuError {
  const sign = error === undefined ? "TARGET_CLOSED" : failureSign(error);
  return new RakurakuError(
    "TENANT_UNREACHABLE",
    `楽楽精算を開いていたブラウザが途中で止まりました（${sign}）。少し待ってからもう一度お試しください`,
    { retryable: true, detail: sign, crash: error === undefined ? undefined : crashSigns(error) },
  );
}

/**
 * ログインが切れていた。★ここではログインし直さない（取得の中で1回だけ、ブラウザ側が登録した控えで入り直す）
 */
export function sessionExpiredError(): RakurakuError {
  return new RakurakuError("SESSION_EXPIRED", "楽楽精算のログインが切れました", {
    sessionLost: true,
  });
}

/** 部門が選べないときの文。選べるものを添えて、利用者が自分で判断できるようにする */
export function departmentNotAvailableText(wanted: string, available: { label: string }[]): string {
  const list = available.map((d) => d.label).join(" / ");
  return list
    ? `このアカウントでは「${wanted}」を選べません。選べるのは ${list} です`
    : `このアカウントでは部門を選べません（選択肢が空でした）`;
}

/** 部門を選んだのに、確かめ直すと切り替わっていなかったときの文 */
export function departmentSwitchFailedText(wanted: string, current: string | null): string {
  const now = current ? `いまは「${current}」のままです。` : "";
  return `部門を「${wanted}」に切り替えられませんでした（${now}別の部門の伝票を取らないよう止めました。楽楽精算の画面が変わった可能性があります）`;
}

/** 一覧に着いたはずなのに一覧表が無いときの文 */
export function listNotPermittedText(label: string): string {
  return `このアカウントでは${label}の一覧を開けません（閲覧権限が無い可能性があります）`;
}

/** 一覧の画面そのものに着かなかったときの文 */
export function listNotFoundText(label: string): string {
  return `${label}の一覧の画面を開けませんでした（閲覧権限が無いか、楽楽精算の画面が変わった可能性があります）`;
}

/**
 * メニューが見つからないときの文。★設定の誤りだけを疑わせない。
 * item を渡すと、何段目のどの項目で見つからなかったかを添える（多段メニューで要る）。
 */
export function menuNotFoundText(label: string, item?: string): string {
  const base = `このアカウントでは${label}のメニューが出ません（閲覧権限が無いか、楽楽精算の画面が変わった可能性があります）`;
  return item ? `${base}。見つからなかった項目: ${item}` : base;
}

/**
 * どの経路でも一覧を開けなかったときの文。
 * ★試した経路とその理由を並べる（アカウントの権限で使える画面が違うので、
 *   「閲覧が無い」のか「画面が変わった」のかを利用者と開発者が見分けられるようにする）。
 */
export function listRoutesFailedText(
  label: string,
  tried: readonly { route: { label: string }; message: string }[],
): string {
  const lines = tried.map((t) => `${t.route.label} → ${t.message}`).join(" ／ ");
  return `このアカウントでは${label}の一覧をどの経路でも開けませんでした。試した経路: ${lines}`;
}

/** 固定された経路がその種類に無いときの文 */
export function routeNotAvailableText(label: string, routes: readonly { label: string }[]): string {
  return `${label}にはその一覧の経路がありません（選べるのは ${routes.map((r) => r.label).join(" / ")} です）`;
}

/** 部門のプルダウンそのものが無いときの文 */
export const DEPT_SELECT_MISSING_TEXT =
  "このアカウントには部門の切り替えがありません（部門内検索の権限が無い可能性があります）";
