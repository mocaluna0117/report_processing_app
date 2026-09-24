/**
 * 門番（proxy.ts が呼ぶ）。どのリクエストを通すかを決める。外とのやり取りは lookup だけ。
 *
 * 規則の順:
 * 1. off → 通す（手元でアカウントを使わない）
 * 2. broken → 全部 503（★開いたままにしない）
 * 3. /login・/api/login・/api/logout → 通す
 * 4. 印が無い・壊れている・前の合言葉の印 → API は 401（文字）、ページは /login へ
 * 5. 前の確認から5分 → Redis で確かめ直す（止めた・パスワードを変えた・消した・ほかの端末でログインした を届ける）
 *    ★画面を開いた・読み込み直したとき（navigation）は、5分を待たずに毎回確かめる。
 *      ほかの端末でログインしたら、前の端末は次に読み込んだときにログイン画面になる（それまでは名前がそのまま出る）
 *    落ちていれば12時間までは通す。
 *    ★どのリクエストでも5分ごとには確かめ直す（Sec-Fetch-Dest などの、送る側が書き換えられるヘッダーで省かない。
 *      ヘッダーは確かめる回数を増やすのにだけ使う）
 * 6. 仮のパスワードの人は、パスワードを決める画面とその送信先・ログアウトだけ
 */
import type { AuthConfig } from "@/lib/account/config";
import { type AccountRecord, replacedByLogin, sessionRevoked } from "@/lib/account/record";
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
  /** 画面を開いた・読み込み直した（Sec-Fetch-Dest: document など）。★確かめる回数を増やすのにだけ使う */
  navigation?: boolean;
}

const isApi = (pathname: string) => pathname.startsWith("/api/");

/** 印が切れた理由（ログイン画面の文を変える）。elsewhere = ほかの端末で同じアカウントにログインした */
type ExpiredReason = "1" | "elsewhere";

function denied(input: GateInput, hadToken: boolean, reason: ExpiredReason = "1"): GateDecision {
  if (isApi(input.pathname)) return { kind: "text", status: 401, body: UNAUTHORIZED_TEXT, clear: hadToken };
  const params = new URLSearchParams();
  const next = safeNextPath(`${input.pathname}${input.search}`);
  if (next !== "/") params.set("next", next);
  if (hadToken) params.set("expired", reason);
  const query = params.toString();
  return { kind: "redirect", location: `/login${query ? `?${query}` : ""}`, clear: hadToken };
}

export async function decideAccess(input: GateInput, lookup: Lookup): Promise<GateDecision> {
  const { config, pathname, session, nowSec } = input;
  if (config.kind === "off") return { kind: "pass" };
  if (config.kind === "broken") return { kind: "text", status: 503, body: BROKEN_TEXT, clear: false };
  if (OPEN_PATHS.has(pathname)) return { kind: "pass" };
  if (session.kind === "none") return denied(input, session.hadToken);

  const { claims } = session;
  let reissue: AccountRecord | undefined;
  const stale = input.navigation === true || nowSec - claims.chk >= RECHECK_SEC;
  if (stale) {
    const found = await lookup(claims.u);
    if (found === "unavailable") {
      if (nowSec - claims.chk >= OUTAGE_GRACE_SEC) {
        return { kind: "text", status: 503, body: UNAVAILABLE_TEXT, clear: false };
      }
    } else if (sessionRevoked(found, claims.sv)) {
      return denied(input, true, found && replacedByLogin(found) ? "elsewhere" : "1");
    } else if (found && found.sv === claims.sv) {
      reissue = found;
    }
    // ★印の版のほうが新しいとき（置き場所の読みが少し遅れている）は通すが、出し直さない（次にまた確かめる）
  }

  if (claims.mc === 1 && !MUST_CHANGE_PATHS.has(pathname)) {
    if (isApi(pathname)) return { kind: "text", status: 401, body: UNAUTHORIZED_TEXT, clear: false };
    return { kind: "redirect", location: "/account", clear: false };
  }
  return reissue ? { kind: "pass", reissue } : { kind: "pass" };
}
