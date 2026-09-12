import "server-only";
import type { Page } from "playwright-core";
import type { TenantConfig } from "./config";
import { contentFrame } from "./frames";

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
  | "TENANT_UNREACHABLE";

export interface LoginResult {
  code: LoginCode;
  message: string;
}

const PASSWORD_SELECTOR = 'input[type="password"]';
const USER_SELECTOR = 'input[type="text"]:visible';

const FAILED_MESSAGE = [
  "ログインできませんでした。**やり直しません**",
  "（楽楽精算は連続して失敗するとアカウントがロックされるため）。",
  "考えられる原因: パスワードが変わった／期限切れ／IDが違う／IP制限・SSOが有効になった。",
].join("");

export async function autoLoginOnce(
  page: Page,
  tenant: TenantConfig,
  credentials: { userId: string; password: string },
): Promise<LoginResult> {
  try {
    await page.goto(tenant.loginUrl, { waitUntil: "load", timeout: 30_000 });
  } catch {
    return { code: "TENANT_UNREACHABLE", message: "楽楽精算のログイン画面に繋がりませんでした" };
  }

  const frame = await contentFrame(page);
  const passwordBox = frame.locator(PASSWORD_SELECTOR);
  if ((await passwordBox.count()) === 0) {
    return {
      code: "LOGIN_FORM_NOT_FOUND",
      message: "ログイン画面のパスワード欄が見つかりません（画面が変わった可能性）",
    };
  }
  const userBox = frame.locator(USER_SELECTOR);
  if ((await userBox.count()) === 0) {
    return {
      code: "LOGIN_FORM_NOT_FOUND",
      message: "ログイン画面のID欄が見つかりません（画面が変わった可能性）",
    };
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

  // ログイン後の画面に来たかを確認する（パスワード欄が消えていれば成功とみなす）
  if (await isLoginScreen(page)) {
    return { code: "LOGIN_FAILED", message: FAILED_MESSAGE };
  }
  return { code: "OK", message: "ログインしました" };
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
