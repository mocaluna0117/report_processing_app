/**
 * 門番（proxy.ts が呼ぶ）。どのリクエストを通すかを決める。外とのやり取りは lookup だけ。
 *
 * 規則の順:
 * 1. off → 通す（手元でアカウントを使わない）
 * 2. broken → 全部 503（★開いたままにしない）
 * 3. /login・/api/login・/api/logout → 通す
 * 4. 旧合言葉のクッキー → 通す（APP_PASSWORD がある間だけ。readSession が判断する）
 * 5. 印が無い・壊れている → API は 401（文字）、ページは /login へ
 * 6. 前の確認から5分 → Redis で確かめ直す（止めた・パスワードを変えた・消した を届ける）
 *    落ちていれば12時間までは通す。
 *    ★どのリクエストでも確かめ直す（Sec-Fetch-Dest などの、送る側が書き換えられるヘッダーで省かない）
 * 7. 仮のパスワードの人は、パスワードを決める画面とその送信先・ログアウトだけ
 */
import type { AuthConfig } from "@/lib/account/config";
import type { AccountRecord } from "@/lib/account/record";
import { OUTAGE_GRACE_SEC, RECHECK_SEC, type SessionState } from "@/lib/account/session";
import { safeNextPath } from "@/lib/auth";

export type Lookup = (id: string) => Promise<AccountRecord | null | "unavailable">;

export type GateDecision =
  | { kind: "pass"; reissue?: AccountRecord }
  | { kind: "redirect"; location: string; clear: boolean }
  | { kind: "text"; status: 401 | 503; body: string; clear: boolean };

export const UNAUTHORIZED_TEXT = "認証が必要です";
export const BROKEN_TEXT = "Folio のログインの設定が足りないため、使えません（管理者へ連絡してください）";
export const UNAVAILABLE_TEXT = "いまログインを確かめられません。少し待ってから読み込み直してください";

/** ログインしていなくても通す口 */
const OPEN_PATHS = new Set(["/login", "/api/login", "/api/logout"]);
/** 仮のパスワードの人が使える口 */
const MUST_CHANGE_PATHS = new Set(["/account", "/api/account/password", "/api/logout"]);

export interface GateInput {
  config: AuthConfig;
  pathname: string;
  search: string;
  session: SessionState;
  nowSec: number;
}

const isApi = (pathname: string) => pathname.startsWith("/api/");

function denied(input: GateInput, hadToken: boolean): GateDecision {
  if (isApi(input.pathname)) return { kind: "text", status: 401, body: UNAUTHORIZED_TEXT, clear: hadToken };
  const params = new URLSearchParams();
  const next = safeNextPath(`${input.pathname}${input.search}`);
  if (next !== "/") params.set("next", next);
  if (hadToken) params.set("expired", "1");
  const query = params.toString();
  return { kind: "redirect", location: `/login${query ? `?${query}` : ""}`, clear: hadToken };
}

export async function decideAccess(input: GateInput, lookup: Lookup): Promise<GateDecision> {
  const { config, pathname, session, nowSec } = input;
  if (config.kind === "off") return { kind: "pass" };
  if (config.kind === "broken") return { kind: "text", status: 503, body: BROKEN_TEXT, clear: false };
  if (OPEN_PATHS.has(pathname)) return { kind: "pass" };
  if (session.kind === "legacy") return { kind: "pass" };
  if (session.kind === "none") return denied(input, session.hadToken);

  const { claims } = session;
  let reissue: AccountRecord | undefined;
  const stale = nowSec - claims.chk >= RECHECK_SEC;
  if (stale) {
    const found = await lookup(claims.u);
    if (found === "unavailable") {
      if (nowSec - claims.chk >= OUTAGE_GRACE_SEC) {
        return { kind: "text", status: 503, body: UNAVAILABLE_TEXT, clear: false };
      }
    } else if (!found || found.disabled || found.sv !== claims.sv) {
      return denied(input, true);
    } else {
      reissue = found;
    }
  }

  if (claims.mc === 1 && !MUST_CHANGE_PATHS.has(pathname)) {
    if (isApi(pathname)) return { kind: "text", status: 401, body: UNAUTHORIZED_TEXT, clear: false };
    return { kind: "redirect", location: "/account", clear: false };
  }
  return reissue ? { kind: "pass", reissue } : { kind: "pass" };
}
