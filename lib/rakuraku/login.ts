import "server-only";
import type { Page } from "playwright-core";
import type { TenantConfig } from "./config";
import { contentFrame } from "./frames";
import { type LandingMarkers, readLandingMarkers } from "./landing";

/**
 * 楽楽精算へのログイン。
 *
 * ★★ リトライは絶対に行わない。★★
 *   楽楽精算は連続してログインに失敗するとアカウントがロックされる仕様。
 *   1回試して駄目なら理由を返して止め、人に判断を委ねる。
 *   呼ぶ側も、失敗を受け取ったら自動で呼び直さないこと。
 */
export type LoginCode =
  | "OK"
  | "LOGIN_FORM_NOT_FOUND"
  | "LOGIN_FAILED"
  /** パスワード欄は消えたが、ログイン後のいつもの画面にならなかった（お知らせだけの画面など） */
  | "LOGIN_UNCONFIRMED"
  /** 打つ前に取りやめた（beforeSubmit が false。登録が変わった・置き場所に届かない） */
  | "LOGIN_ABORTED"
  | "TENANT_UNREACHABLE";

export interface LoginResult {
  code: LoginCode;
  message: string;
  /** パスワードを楽楽精算へ送ったか（★送ったものだけが、ロックの数に入りうる） */
  submitted: boolean;
  /** 着いた画面の目印（送ったときだけ。ログに数だけ残す） */
  markers?: LandingMarkers;
  /**
   * ログイン後に着いた画面の URL。
   *
   * ★ これを覚えておくこと。ログイン画面の URL へ戻ると、ログイン済みでも
   *   フォームが出る作りなので、「パスワード欄があるか」で状態を見ると
   *   **必ず「切れている」と誤判定する**。次回はこの URL を開いて確かめる。
   */
  homeUrl?: string;
}

const PASSWORD_SELECTOR = 'input[type="password"]';
const USER_SELECTOR = 'input[type="text"]:visible';

const FAILED_MESSAGE = [
  "ログインできませんでした。**やり直しません**",
  "（楽楽精算は連続して失敗するとアカウントがロックされるため）。",
  "考えられる原因: パスワードが変わった／期限切れ／IDが違う／IP制限・SSOが有効になった。",
].join("");

const UNCONFIRMED_MESSAGE = [
  "楽楽精算にログインできたか確かめられませんでした（いつもの画面になりませんでした）。**やり直しません**。",
  "楽楽精算の画面で直接ログインできるか確かめてください。",
].join("");

/** 着いた画面を確かめる長さ（frameset の中身が出そろうまで待つ） */
export const CONFIRM_WAIT_MS = 6_000;
const CONFIRM_STEP_MS = 500;

export interface LoginHooks {
  /** パスワードを打つ直前に呼ぶ。false を返したら打たずに LOGIN_ABORTED */
  beforeSubmit?: () => Promise<boolean>;
  /** 確かめる長さ（テスト用） */
  confirmWaitMs?: number;
}

/**
 * ログインしたあとの画面で、成功をはっきり確かめる（2026-09-25）。
 * ★パスワード欄が無い**うえに**「ワークフロー」タブが見えたときだけ成功。
 *   パスワード欄が消えただけ（お知らせだけの画面など）は LOGIN_UNCONFIRMED（成功とみなさない）。
 * ★本番のログで、ログイン後の画面に「ワークフロー」タブと main のフレームがあることを確かめてある。
 */
export function judgeLanding(markers: LandingMarkers): "OK" | "LOGIN_FAILED" | "LOGIN_UNCONFIRMED" {
  if (markers.passwordFields > 0) return "LOGIN_FAILED";
  return markers.workflowTab ? "OK" : "LOGIN_UNCONFIRMED";
}

export async function autoLoginOnce(
  page: Page,
  tenant: TenantConfig,
  credentials: { userId: string; password: string },
  hooks: LoginHooks = {},
): Promise<LoginResult> {
  try {
    await page.goto(tenant.loginUrl, { waitUntil: "load", timeout: 30_000 });
  } catch {
    return { code: "TENANT_UNREACHABLE", message: "楽楽精算のログイン画面に繋がりませんでした", submitted: false };
  }

  const frame = await contentFrame(page);
  const passwordBox = frame.locator(PASSWORD_SELECTOR);
  if ((await passwordBox.count()) === 0) {
    return {
      code: "LOGIN_FORM_NOT_FOUND",
      message: "ログイン画面のパスワード欄が見つかりません（画面が変わった可能性）",
      submitted: false,
    };
  }
  const userBox = frame.locator(USER_SELECTOR);
  if ((await userBox.count()) === 0) {
    return {
      code: "LOGIN_FORM_NOT_FOUND",
      message: "ログイン画面のID欄が見つかりません（画面が変わった可能性）",
      submitted: false,
    };
  }

  // ★打つ前に「送った」と書く。書けなければ打たない（数えられないまま送らない）
  if (hooks.beforeSubmit && !(await hooks.beforeSubmit())) {
    return { code: "LOGIN_ABORTED", message: "楽楽精算へのログインを取りやめました", submitted: false };
  }

  await userBox.first().fill(credentials.userId);
  await passwordBox.first().fill(credentials.password);

  const button = frame.getByRole("button", { name: /ログイン/ });
  if ((await button.count()) > 0) {
    await button.first().click();
  } else {
    await passwordBox.first().press("Enter");
  }
  await page.waitForLoadState("load").catch(() => null);
  await page.waitForTimeout(2_000);

  // ★着いた画面の目印で確かめる。frameset の中身が遅れて出ることがあるので、少しのあいだ見直す
  const waitMs = hooks.confirmWaitMs ?? CONFIRM_WAIT_MS;
  const until = Date.now() + waitMs;
  let markers = await readLandingMarkers(page);
  while (judgeLanding(markers) !== "OK" && Date.now() < until) {
    await page.waitForTimeout(CONFIRM_STEP_MS);
    markers = await readLandingMarkers(page);
  }
  const verdict = judgeLanding(markers);
  if (verdict === "LOGIN_FAILED") return { code: "LOGIN_FAILED", message: FAILED_MESSAGE, submitted: true, markers };
  if (verdict === "LOGIN_UNCONFIRMED") return { code: "LOGIN_UNCONFIRMED", message: UNCONFIRMED_MESSAGE, submitted: true, markers };
  return { code: "OK", message: "ログインしました", homeUrl: page.url(), submitted: true, markers };
}

/** いまログイン画面にいるか（＝ログインしていないか） */
export async function isLoginScreen(page: Page): Promise<boolean> {
  const frame = await contentFrame(page);
  return await frame
    .locator(PASSWORD_SELECTOR)
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}
